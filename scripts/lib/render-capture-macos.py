#!/usr/bin/env python3
"""Validate the signed universal macOS capture payload without Apple tools.

Mach-O parsing ported from godot-scene-web's
experiments/render-stream/scripts/m-imports.py (MIT).
"""

from pathlib import Path
import posixpath
import struct
import sys


ARCHES = {0x01000007: "x86_64", 0x0100000C: "arm64"}
LOADS = {0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023}
ALLOW = ["/usr/lib/", "/System/Library/"]


class MachOError(ValueError):
    pass


def take(data, offset, size):
    if offset < 0 or size < 0 or offset + size > len(data):
        raise MachOError(f"truncated Mach-O at offset 0x{offset:x}")
    return bytes(data[offset:offset + size])


def unpack(data, fmt, offset):
    return struct.unpack(fmt, take(data, offset, struct.calcsize(fmt)))


def supported_subtype(cpu, subtype):
    if cpu == 0x01000007:
        return subtype & 0x00FFFFFF == 3  # CPU_SUBTYPE_X86_64_ALL, excluding capability bits.
    return cpu == 0x0100000C and subtype == 0


def thin(data):
    magic = take(data, 0, 4)
    endian = {b"\xcf\xfa\xed\xfe": "<", b"\xfe\xed\xfa\xcf": ">"}.get(magic)
    if not endian:
        raise MachOError("expected a 64-bit Mach-O slice")
    _, cpu, subtype, filetype, count, size, _, _ = unpack(data, endian + "8I", 0)
    if cpu not in ARCHES:
        raise MachOError(f"unsupported CPU type 0x{cpu:x}")
    if filetype != 6 or not supported_subtype(cpu, subtype):
        raise MachOError("expected a dylib with the supported CPU subtype")
    commands = take(data, 32, size)
    offset, imports, identity, signature = 0, [], None, False
    for _ in range(count):
        cmd, length = unpack(commands, endian + "II", offset)
        if length < 8 or length % 8:
            raise MachOError("invalid load-command size or alignment")
        command = take(commands, offset, length)
        if cmd == 0x1D:  # LC_CODE_SIGNATURE; cryptographic verification runs on macOS.
            start, size = unpack(command, endian + "II", 8)
            if size == 0:
                raise MachOError("empty code signature")
            take(data, start, size)
            signature = True
        if cmd in LOADS or cmd == 0xD:  # LC_ID_DYLIB is identity, not an import.
            name_offset, _, _, _ = unpack(command, endian + "4I", 8)
            if not 24 <= name_offset < length:
                raise MachOError("invalid dylib name offset")
            end = command.find(b"\0", name_offset)
            if end <= name_offset:
                raise MachOError("empty or unterminated dylib name")
            try:
                name = command[name_offset:end].decode("utf-8")
            except UnicodeDecodeError as exc:
                raise MachOError("invalid UTF-8 dylib name") from exc
            if cmd == 0xD:
                if identity is not None:
                    raise MachOError("duplicate LC_ID_DYLIB")
                identity = name
            else:
                imports.append(name)
        offset += length
    if offset != len(commands):
        raise MachOError("load-command count does not match sizeofcmds")
    if not signature:
        raise MachOError("slice is missing LC_CODE_SIGNATURE")
    return {"subtype": subtype, "arch": ARCHES[cpu], "imports": sorted(set(imports)), "identity": identity}


def slices(data):
    magic = take(data, 0, 4)
    fat = {b"\xca\xfe\xba\xbe": (">", False), b"\xbe\xba\xfe\xca": ("<", False),
           b"\xca\xfe\xba\xbf": (">", True), b"\xbf\xba\xfe\xca": ("<", True)}.get(magic)
    if not fat:
        raise MachOError("expected a fat Mach-O with arm64 and x86_64 slices")
    endian, wide = fat
    count = unpack(data, endian + "I", 4)[0]
    stride = 32 if wide else 20
    take(data, 8, count * stride)
    if count == 0:
        raise MachOError("empty universal binary")
    result, ranges, seen = [], [], set()
    for index in range(count):
        entry = 8 + index * stride
        cpu, subtype = unpack(data, endian + "II", entry)
        if not supported_subtype(cpu, subtype):
            raise MachOError("unsupported universal CPU subtype")
        if wide:
            offset, size, alignment, reserved = unpack(data, endian + "QQII", entry + 8)
            if reserved:
                raise MachOError("nonzero fat_arch_64 reserved field")
        else:
            offset, size, alignment = unpack(data, endian + "III", entry + 8)
        if alignment > 63 or offset % (1 << alignment) or offset < 8 + count * stride:
            raise MachOError("invalid universal slice offset/alignment")
        if any(offset < end and start < offset + size for start, end in ranges):
            raise MachOError("overlapping universal slices")
        image = thin(take(data, offset, size))
        if ARCHES.get(cpu) != image["arch"] or subtype != image["subtype"] or cpu in seen:
            raise MachOError("duplicate or mismatched universal CPU type")
        seen.add(cpu)
        ranges.append((offset, offset + size))
        result.append(image)
    return result


def allowed(name):
    return any(name.startswith(prefix) and posixpath.normpath(name).startswith(prefix)
               for prefix in ALLOW)



def verify(path):
    path = Path(path)
    images = slices(path.read_bytes())
    if {image["arch"] for image in images} != set(ARCHES.values()):
        raise MachOError(f"{path}: expected exactly arm64 and x86_64 slices")
    for image in images:
        for name in image["imports"]:
            if not allowed(name):
                raise MachOError(f"{path} [{image['arch']}]: non-system import: {name}")
        if path.name == "librender_stream_net.dylib" and image["identity"] != "@rpath/librender_stream_net.dylib":
            raise MachOError(f"{path} [{image['arch']}]: wrong LC_ID_DYLIB")


if __name__ == "__main__":
    try:
        for path in sys.argv[1:]:
            verify(path)
    except (OSError, ValueError) as error:
        sys.exit(f"render capture: {error}")
