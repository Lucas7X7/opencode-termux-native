#!/usr/bin/env python3
"""Graft the OpenCode compiled module graph onto a Bionic Bun base.

OpenCode ships as a Bun standalone executable: a Bun runtime, a length-prefixed
serialized module graph, and the ``---- Bun! ----`` trailer. The official
``linux-arm64`` build links that runtime against glibc, which Android does not
have. This script keeps the OpenCode module graph but renders it on a Bun base
built for Android's Bionic libc, producing a single native ELF.

The module graph also embeds native shared objects (``libopentui.so`` and
friends) that were linked against glibc. ``--opentui`` swaps the embedded
``libopentui*.so`` for a Bionic build in place, so the serialized offsets stay
valid, and lowers the length recorded for that module to the size of the
replacement so the runtime does not write the padding to disk.

Only the Python standard library is used so the build runs anywhere.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import tarfile

TRAILER = b"\n---- Bun! ----\n"
ELF_MAGIC = b"\x7fELF"
# Bun's standalone payload (ELF) is laid out as:
#
#   [Bun runtime][u64 lead][serialized data (byte_count)][Offsets (32 bytes)][trailer]
#
# ``Offsets`` is a #[repr(C)] struct whose first field, ``byte_count``, is the
# size of the serialized data blob that precedes it. The remaining fields are
# offsets relative to the start of that blob, so the blob can be transplanted
# onto a different Bun runtime unchanged.
#
# Two details that are easy to get wrong, and that make a grafted binary fall
# back to the Bun CLI instead of running its embedded entrypoint:
#
#   * the ``lead`` u64 sits between the runtime and the blob and must be
#     carried over. It equals the blob length plus the 48 bytes of trailing
#     struct, i.e. ``len(blob) + OFFSETS_SIZE + len(TRAILER)``.
#   * there is NO ``u64 total`` footer. The upstream file keeps its section
#     table after the trailer, and Bun locates the payload by scanning back for
#     the trailer; a fabricated footer at EOF invalidates it.
OFFSETS_SIZE = 32
LEAD_SIZE = 8


def fail(message: str) -> None:
    print(f"graft: {message}", file=sys.stderr)
    raise SystemExit(1)


def elftype(path: str) -> str:
    with open(path, "rb") as handle:
        header = handle.read(20)
    if header[:4] != ELF_MAGIC:
        fail(f"{path} is not an ELF binary")
    machine = struct.unpack_from("<H", header, 18)[0]
    return {0xB7: "aarch64", 0x3E: "x86_64"}.get(machine, f"machine 0x{machine:x}")


def extract_opencode(tarball: str) -> bytes:
    """Read the upstream binary straight out of the archive.

    Extracting it to a temporary directory first writes ~180 MB to disk only to
    read it straight back into memory, which is enough to run a small CI runner
    or a phone out of space for no reason.
    """
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive.getmembers():
            if os.path.basename(member.name) == "opencode" and member.isfile():
                handle = archive.extractfile(member)
                if handle is None:
                    fail("could not read the 'opencode' member from the tarball")
                with handle:
                    return handle.read()
    fail("no 'opencode' binary inside the upstream tarball")


def payload_layout(source: bytes) -> tuple[int, int, int, int, int, int]:
    """Return (trailer_pos, byte_count, graph_start, modules_off, modules_len, lead)."""
    trailer_pos = source.rfind(TRAILER)
    if trailer_pos < 0:
        fail("Bun trailer not found in the OpenCode binary")

    offsets_pos = trailer_pos - OFFSETS_SIZE
    if offsets_pos < 0:
        fail("truncated Bun offsets struct")

    byte_count = struct.unpack_from("<Q", source, offsets_pos)[0]
    modules_off, modules_len = struct.unpack_from("<II", source, offsets_pos + 8)
    graph_start = offsets_pos - byte_count
    if byte_count == 0 or graph_start - LEAD_SIZE < 0:
        fail(
            "implausible module graph "
            f"(byte_count={byte_count} binary={len(source)})"
        )

    # The 8 bytes in front of the blob are a length prefix for everything from
    # the blob's start through the trailer. Verifying it keeps us honest about
    # where the blob really begins instead of trusting a single field.
    lead_pos = graph_start - LEAD_SIZE
    lead = struct.unpack_from("<Q", source, lead_pos)[0]
    expected = byte_count + OFFSETS_SIZE + len(TRAILER)
    if lead != expected:
        fail(
            "Bun payload lead does not match the blob length "
            f"(lead={lead} expected={expected})"
        )

    return trailer_pos, byte_count, graph_start, modules_off, modules_len, lead


def module_graph(source: bytes) -> bytes:
    """Return the self-contained Bun payload, lead and trailer included."""
    (
        trailer_pos,
        _byte_count,
        graph_start,
        _modules_off,
        _modules_len,
        _lead,
    ) = payload_layout(source)
    graph = source[graph_start - LEAD_SIZE : trailer_pos + len(TRAILER)]
    if not graph.endswith(TRAILER):
        fail("module graph does not end with the Bun trailer")
    if graph[:4] == ELF_MAGIC:
        fail("extracted module graph looks like an ELF; offsets are wrong")
    return graph


def detect_stride(blob: bytes, modules_off: int, modules_len: int) -> int:
    """Return the CompiledModuleGraphFile stride (52 on Bun >= 1.3.11, 36 below)."""
    for stride in (52, 36):
        if modules_len % stride:
            continue
        valid = True
        for i in range(modules_len // stride):
            rec = modules_off + i * stride
            name_off, name_len = struct.unpack_from("<II", blob, rec)
            if not 0 < name_len < 4096 or name_off + name_len > len(blob):
                valid = False
                break
            name = blob[name_off : name_off + name_len]
            if not name.startswith(b"/") or any(b < 0x20 or b > 0x7E for b in name):
                valid = False
                break
        if valid:
            return stride
    fail("could not determine the CompiledModuleGraphFile stride")


def patch_embedded_library(
    source: bytearray, replacement: bytes, stem: bytes = b"libopentui"
) -> tuple[str, int]:
    """Replace an embedded ``.so`` in place. Returns its name and recorded length.

    The replacement is written into the slot reserved by the graph and then the
    recorded ``contents_len`` is lowered to the real size of the object.

    That second step matters at runtime. Bun materialises an embedded library
    into a temp file before ``dlopen`` and writes exactly ``contents_len`` bytes,
    so keeping the padded length left a ~13 MB copy of a 5.6 MB library behind in
    ``/tmp`` on every single run. Offsets in the graph are absolute, so shortening
    the recorded length moves nothing and the freed bytes stay as padding inside
    the blob, where they are inert.
    """
    (
        _trailer,
        byte_count,
        graph_start,
        modules_off,
        modules_len,
        _lead,
    ) = payload_layout(source)
    blob = source[graph_start : graph_start + byte_count]
    stride = detect_stride(blob, modules_off, modules_len)

    for i in range(modules_len // stride):
        rec = modules_off + i * stride
        name_off, name_len = struct.unpack_from("<II", blob, rec)
        contents_off, contents_len = struct.unpack_from("<II", blob, rec + 8)
        name = bytes(blob[name_off : name_off + name_len])
        if stem in name and name.endswith(b".so"):
            if len(replacement) > contents_len:
                fail(
                    f"embedded {name.decode()} is {contents_len} bytes but the "
                    f"replacement is {len(replacement)}; the graph would need "
                    "reserializing"
                )
            start = graph_start + contents_off
            source[start : start + contents_len] = replacement.ljust(contents_len, b"\x00")
            struct.pack_into("<I", source, graph_start + rec + 12, len(replacement))
            return name.decode(), len(replacement)
    fail(f"no embedded library matching {stem.decode()!r} found in the module graph")


def graft(
    base_path: str,
    tarball: str,
    out_path: str,
    libopentui: str | None = None,
) -> dict[str, object]:
    with open(base_path, "rb") as handle:
        base = handle.read()

    base_type = elftype(base_path)
    if base_type != "aarch64":
        fail(f"Bionic base must be aarch64, found {base_type}")

    source = bytearray(extract_opencode(tarball))

    patched: str | None = None
    recorded: int | None = None
    if libopentui is not None:
        with open(libopentui, "rb") as handle:
            replacement = handle.read()
        if replacement[:4] != ELF_MAGIC:
            fail(f"{libopentui} is not an ELF shared object")
        patched, recorded = patch_embedded_library(source, replacement)

    graph = module_graph(bytes(source))

    total = len(base) + len(graph)
    result = base + graph

    with open(out_path, "wb") as handle:
        handle.write(result)
    os.chmod(out_path, 0o755)

    return {
        "base": len(base),
        "graph": len(graph),
        "total": total,
        "patched": patched,
        "recorded": recorded,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Bionic aarch64 Bun base binary")
    parser.add_argument("--opencode-tar", required=True, help="official opencode-linux-arm64.tar.gz")
    parser.add_argument("--out", required=True, help="output grafted opencode binary")
    parser.add_argument(
        "--opentui",
        help="Bionic libopentui.so to swap for the embedded glibc build (same length)",
    )
    args = parser.parse_args()

    stats = graft(args.base, args.opencode_tar, args.out, args.opentui)
    patched = stats["patched"]
    recorded = stats["recorded"]
    extra = f" opentui={patched}" if patched else ""
    if recorded is not None:
        extra += f" recorded_len={recorded}"
    print(
        f"grafted {args.out}: base={stats['base']} graph={stats['graph']} "
        f"total={stats['total']}{extra}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
