#!/usr/bin/env python3
"""Recover the Bionic seed assets from a known-good grafted OpenCode binary.

Given a working graft (``base + graph + footer``), write out:

* ``bun-base.bin``      the Bionic Bun runtime prefix, ready for ``graft.py --base``
* ``libopentui.so``     the embedded Bionic libopentui, unpadded to its real ELF
                        length so it can be fed back to ``graft.py --opentui``

The embedded libraries in a grafted binary were already replaced in place and
zero-padded to the upstream slot length, so the real object length is recovered
from the ELF section header table rather than by trimming zeros.
"""

from __future__ import annotations

import os
import struct
import sys

TRAILER = b"\n---- Bun! ----\n"
OFFSETS_SIZE = 32
ELF_MAGIC = b"\x7fELF"


def fail(message: str) -> None:
    print(f"extract-seed: {message}", file=sys.stderr)
    raise SystemExit(1)


def payload_layout(buf: bytes) -> tuple[int, int, int, int, int]:
    trailer_pos = buf.rfind(TRAILER)
    if trailer_pos < 0:
        fail("Bun trailer not found")
    offsets_pos = trailer_pos - OFFSETS_SIZE
    if offsets_pos < 0:
        fail("truncated Bun offsets struct")
    byte_count = struct.unpack_from("<Q", buf, offsets_pos)[0]
    modules_off, modules_len = struct.unpack_from("<II", buf, offsets_pos + 8)
    graph_start = offsets_pos - byte_count
    if byte_count == 0 or graph_start <= 0:
        fail(f"implausible module graph (byte_count={byte_count} binary={len(buf)})")
    return trailer_pos, byte_count, graph_start, modules_off, modules_len


def detect_stride(blob: bytes, modules_off: int, modules_len: int) -> int:
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


def elf_real_size(obj: bytes) -> int:
    """Smallest length that still contains the whole ELF, from the section table."""
    if len(obj) < 0x40 or obj[:4] != ELF_MAGIC:
        return len(obj)
    e_shoff = struct.unpack_from("<Q", obj, 0x28)[0]
    e_shentsize = struct.unpack_from("<H", obj, 0x3A)[0]
    e_shnum = struct.unpack_from("<H", obj, 0x3C)[0]
    end = e_shoff + e_shentsize * e_shnum if e_shoff and e_shnum else 0
    if end <= 0 or end > len(obj):
        return len(obj)
    return end


def elf_machine(obj: bytes) -> str:
    if obj[:4] != ELF_MAGIC:
        return "not an ELF"
    return {0xB7: "aarch64", 0x3E: "x86_64"}.get(
        struct.unpack_from("<H", obj, 18)[0], "?"
    )


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: extract_seed.py <grafted-binary> <outdir>")
    source, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    with open(source, "rb") as handle:
        data = handle.read()

    _trailer, byte_count, graph_start, modules_off, modules_len = payload_layout(data)
    blob = data[graph_start : graph_start + byte_count]
    stride = detect_stride(blob, modules_off, modules_len)

    base = data[:graph_start]
    base_path = os.path.join(outdir, "bun-base.bin")
    with open(base_path, "wb") as handle:
        handle.write(base)
    os.chmod(base_path, 0o755)
    print(f"bun-base.bin  {len(base)} bytes  {elf_machine(base)}")

    found = 0
    for i in range(modules_len // stride):
        rec = modules_off + i * stride
        name_off, name_len = struct.unpack_from("<II", blob, rec)
        contents_off, contents_len = struct.unpack_from("<II", blob, rec + 8)
        name = bytes(blob[name_off : name_off + name_len])
        if not name.endswith(b".so"):
            continue
        slot = data[graph_start + contents_off : graph_start + contents_off + contents_len]
        real = elf_real_size(slot)
        out_path = os.path.join(outdir, os.path.basename(name.decode()))
        with open(out_path, "wb") as handle:
            handle.write(slot[:real])
        found += 1
        print(
            f"{os.path.basename(out_path)}  real={real} slot={contents_len} "
            f"padding={contents_len - real}  {elf_machine(slot)}"
        )

    if found == 0:
        fail("no embedded shared objects found in the module graph")


if __name__ == "__main__":
    main()