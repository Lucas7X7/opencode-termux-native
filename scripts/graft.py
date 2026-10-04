#!/usr/bin/env python3
"""Graft the OpenCode compiled module graph onto a Bionic Bun base.

OpenCode ships as a Bun standalone executable: a Bun runtime, a serialized
module graph, then an 8-byte ``total_byte_count`` footer. The official
``linux-arm64`` build links that runtime against glibc, which Android does not
have. This script keeps the OpenCode module graph but renders it on a Bun base
built for Android's Bionic libc, producing a single native ELF.

The module graph also embeds native shared objects (``libopentui.so`` and
friends) that were linked against glibc. ``--opentui`` swaps the embedded
``libopentui*.so`` for a Bionic build of the same length, in place, so the
serialized offsets stay valid.

Only the Python standard library is used so the build runs anywhere.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import tarfile
import tempfile

TRAILER = b"\n---- Bun! ----\n"
ELF_MAGIC = b"\x7fELF"
# Bun's standalone payload (ELF) is laid out as:
#
#   [Bun runtime][serialized data (byte_count)][Offsets (32 bytes)][trailer][u64 total]
#
# ``Offsets`` is a #[repr(C)] struct whose first field, ``byte_count``, is the
# size of the serialized data blob that precedes it. The remaining fields are
# offsets relative to the start of that blob, so the blob can be transplanted
# onto a different Bun runtime unchanged.
OFFSETS_SIZE = 32
FOOTER_SIZE = 8


def fail(message: str) -> None:
    print(f"graft: {message}", file=sys.stderr)
    raise SystemExit(1)


def extract_member(archive: tarfile.TarFile, member: tarfile.TarInfo, work: str) -> None:
    try:
        archive.extract(member, work, filter="data")
    except TypeError:
        archive.extract(member, work)


def elftype(path: str) -> str:
    with open(path, "rb") as handle:
        header = handle.read(20)
    if header[:4] != ELF_MAGIC:
        fail(f"{path} is not an ELF binary")
    machine = struct.unpack_from("<H", header, 18)[0]
    return {0xB7: "aarch64", 0x3E: "x86_64"}.get(machine, f"machine 0x{machine:x}")


def extract_opencode(tarball: str) -> bytes:
    with tarfile.open(tarball, "r:gz") as archive:
        member = None
        for candidate in archive.getmembers():
            base = os.path.basename(candidate.name)
            if base == "opencode" and candidate.isfile():
                member = candidate
                break
        if member is None:
            fail("no 'opencode' binary inside the upstream tarball")
        with tempfile.TemporaryDirectory() as work:
            extract_member(archive, member, work)
            with open(os.path.join(work, member.name), "rb") as handle:
                return handle.read()


def payload_layout(source: bytes) -> tuple[int, int, int, int, int]:
    """Return (trailer_pos, byte_count, graph_start, modules_off, modules_len)."""
    trailer_pos = source.rfind(TRAILER)
    if trailer_pos < 0:
        fail("Bun trailer not found in the OpenCode binary")

    offsets_pos = trailer_pos - OFFSETS_SIZE
    if offsets_pos < 0:
        fail("truncated Bun offsets struct")

    byte_count = struct.unpack_from("<Q", source, offsets_pos)[0]
    modules_off, modules_len = struct.unpack_from("<II", source, offsets_pos + 8)
    graph_start = offsets_pos - byte_count
    if byte_count == 0 or graph_start < 0:
        fail(
            "implausible module graph "
            f"(byte_count={byte_count} binary={len(source)})"
        )
    return trailer_pos, byte_count, graph_start, modules_off, modules_len


def module_graph(source: bytes) -> bytes:
    """Return the self-contained Bun payload, trailer included."""
    trailer_pos, _byte_count, graph_start, _modules_off, _modules_len = payload_layout(source)
    graph = source[graph_start : trailer_pos + len(TRAILER)]
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
) -> str:
    """Replace the contents of an embedded ``.so`` in place. Returns its name."""
    _trailer, byte_count, graph_start, modules_off, modules_len = payload_layout(source)
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
            return name.decode()
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
    if libopentui is not None:
        with open(libopentui, "rb") as handle:
            replacement = handle.read()
        if replacement[:4] != ELF_MAGIC:
            fail(f"{libopentui} is not an ELF shared object")
        patched = patch_embedded_library(source, replacement)

    graph = module_graph(bytes(source))

    total = len(base) + len(graph) + FOOTER_SIZE
    result = base + graph + struct.pack("<Q", total)

    with open(out_path, "wb") as handle:
        handle.write(result)
    os.chmod(out_path, 0o755)

    return {"base": len(base), "graph": len(graph), "total": total, "patched": patched}


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
    extra = f" opentui={patched}" if patched else ""
    print(
        f"grafted {args.out}: base={stats['base']} graph={stats['graph']} "
        f"total={stats['total']}{extra}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
