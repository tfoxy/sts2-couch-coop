#!/usr/bin/env python3
"""Live memory census for a running STS2 process (headless seat or host).

Reads `/proc/<pid>/{maps,smaps,pagemap,mem}` from the OUTSIDE. There is no ptrace attach and no stop: the
target keeps running at full speed, so this is safe to point at a live seat mid-session. Nothing is written.

Why a bespoke tool instead of `dotnet-dump` / a Godot profiler:

  * `dotnet-dump` only sees the MANAGED heap, which is a fifth of the picture here, and collecting a dump
    pauses the target long enough to risk an ENet timeout on a live seat.
  * Godot's `Performance` monitors report a single `MemoryStatic` scalar with no attribution.
  * The interesting number — how much RAM Godot's `--headless` dummy renderer is holding in retained texture
    images — is not exposed by either, but it is directly recoverable from the heap layout.

Modes (default: all three):

  --regions   RSS split by allocator: glibc main heap / thread arenas / large mmap chunks, the CLR's GC and
              loader heaps, JIT code, file-backed mappings, shm, thread stacks.
  --chunks    glibc chunk-size histogram, used vs free, i.e. allocator fragmentation.
  --images    Inventory of live Godot `Image` objects by pixel format and dimensions. This is the one that
              answers "is the headless holding assets in RAM".

Usage:
    scripts/headless-memory-census.py <pid> [<pid> ...] [--regions] [--chunks] [--images]
    scripts/headless-memory-census.py --auto            # find the running host + headless seats

Layout facts this depends on (verified against godot-4.5.1-stable and glibc 2.3x on x86-64):

  * glibc thread arenas are 64 MB-ALIGNED mappings whose `heap_info.ar_ptr` is `base + 0x30`. For the first
    heap of an arena the chunk chain starts past `malloc_state`, at `base + 0x8d0`; for subsequent heaps it
    starts right after `heap_info`, at `base + 0x30`.
  * A malloc chunk is `[prev_size:8][size:8][payload]`, `size & ~7` is the real size, `size & 0x2` marks an
    mmapped chunk, and chunk N's in-use bit is `PREV_INUSE` on chunk N+1.
  * Godot `CowData` allocates `[refcount:8][size:8][data...]` (core/templates/cowdata.h, DATA_OFFSET = 16), so
    a Vector's `_ptr` is `chunk + 32`.
  * Godot `Image` (core/io/image.h) declares `format`, then `data`, then `width`, `height`, `mipmaps` — so
    relative to the address holding the data pointer: format at `-16`, width at `+8`, height at `+12`,
    mipmaps at `+16`. Matches are only accepted when width*height*bpp reproduces the buffer size, which makes
    a false positive very unlikely.

IMPORTANT: pages are filtered through `/proc/<pid>/pagemap`'s present bit BEFORE being read. Reading a mapped
but non-resident anonymous page through `/proc/<pid>/mem` faults a zero page in and would inflate the target's
RSS — i.e. the measurement would change what it measures.

Permissions: this machine runs `kernel.yama.ptrace_scope=1`, under which only an ANCESTOR may read another
process's memory. It works on STS2 anyway because the game ships Sentry/crashpad, which opts the process in
via `prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY)` so its own crash handler can dump it. If a run was started
through `scripts/disable-sentry-crashpad.sh`, that opt-in is gone and reads fail with EACCES — then either
re-enable crashpad, run this as root, or `sudo sysctl kernel.yama.ptrace_scope=0`.
"""

from __future__ import annotations

import argparse
import collections
import io
import os
import re
import struct
import sys

PAGE = 4096

# Godot Image::Format, in declaration order (core/io/image.h).
FORMATS = [
    "L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565",
    "RF", "RGF", "RGBF", "RGBAF", "RH", "RGH", "RGBH", "RGBAH", "RGBE9995",
    "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG", "BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU",
    "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11", "ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8",
    "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
    "ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]
# Bytes per pixel for the uncompressed formats. Block-compressed formats are matched on a size range instead.
BPP = {
    "L8": 1, "LA8": 2, "R8": 1, "RG8": 2, "RGB8": 3, "RGBA8": 4, "RGBA4444": 2, "RGB565": 2,
    "RF": 4, "RGF": 8, "RGBF": 12, "RGBAF": 16, "RH": 2, "RGH": 4, "RGBH": 6, "RGBAH": 8,
    "RGBE9995": 4,
}
# Bytes per pixel for block-compressed formats (4x4 blocks).
BLOCK_BPP = {
    "DXT1": 0.5, "DXT3": 1.0, "DXT5": 1.0, "RGTC_R": 0.5, "RGTC_RG": 1.0,
    "BPTC_RGBA": 1.0, "BPTC_RGBF": 1.0, "BPTC_RGBFU": 1.0, "DXT5_RA_AS_RG": 1.0,
    "ETC": 0.5, "ETC2_R11": 0.5, "ETC2_R11S": 0.5, "ETC2_RG11": 1.0, "ETC2_RG11S": 1.0,
    "ETC2_RGB8": 0.5, "ETC2_RGBA8": 1.0, "ETC2_RGB8A1": 0.5, "ETC2_RA_AS_RG": 1.0,
    "ASTC_4x4": 1.0, "ASTC_4x4_HDR": 1.0, "ASTC_8x8": 0.25, "ASTC_8x8_HDR": 0.25,
}

# VRAM-compressed formats: these are what the HeadlessTextureImageEvictor targets first, because a real
# renderer never keeps them on the CPU after upload (the host process holds ~none of them).
VRAM_COMPRESSED = set(BLOCK_BPP)


def mb(value: float) -> str:
    return f"{value / (1 << 20):8.1f} MB"


class Target:
    """Read-only view of one live process."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        # `mem` is opened LAZILY, `pagemap` eagerly, because the kernel gates them differently: reading another
        # process's memory needs PTRACE_MODE_ATTACH (which yama ptrace_scope=1 refuses between same-uid
        # non-relatives, i.e. needs sudo here), while maps/smaps/pagemap only need PTRACE_MODE_READ and are
        # readable for any process of your own uid. Opening `mem` in the constructor made --regions — which reads
        # no process memory at all — fail with the same "Permission denied" as the modes that genuinely need it.
        self._mem: io.BufferedReader | None = None
        self.pagemap = open(f"/proc/{pid}/pagemap", "rb", 0)
        self.vmas = self._read_maps()

    @property
    def mem(self) -> io.BufferedReader:
        if self._mem is None:
            try:
                self._mem = open(f"/proc/{self.pid}/mem", "rb", 0)
            except PermissionError as exc:
                raise PermissionError(
                    f"reading /proc/{self.pid}/mem needs ptrace attach — re-run this mode under sudo "
                    "(yama ptrace_scope=1); --regions works without it"
                ) from exc
        return self._mem

    def _read_maps(self) -> list[dict]:
        out = []
        for line in open(f"/proc/{self.pid}/maps"):
            parts = line.split()
            lo, hi = parts[0].split("-")
            out.append({
                "lo": int(lo, 16),
                "hi": int(hi, 16),
                "perm": parts[1],
                "path": " ".join(parts[5:]) if len(parts) > 5 else "",
            })
        return out

    def read(self, addr: int, size: int) -> bytes:
        self.mem.seek(addr)
        return self.mem.read(size)

    def resident_runs(self, lo: int, hi: int) -> list[tuple[int, int]]:
        """(start, length) runs of pages that are actually resident, per pagemap's present bit."""
        count = (hi - lo) // PAGE
        runs: list[tuple[int, int]] = []
        index = 0
        while index < count:
            batch = min(1 << 16, count - index)
            self.pagemap.seek((lo // PAGE + index) * 8)
            buf = self.pagemap.read(batch * 8)
            if len(buf) < batch * 8:
                batch = len(buf) // 8
            if batch == 0:
                break
            entries = struct.unpack(f"<{batch}Q", buf[:batch * 8])
            run_start = None
            for i, entry in enumerate(entries):
                if entry >> 63 & 1:
                    if run_start is None:
                        run_start = i
                elif run_start is not None:
                    runs.append((lo + (index + run_start) * PAGE, (i - run_start) * PAGE))
                    run_start = None
            if run_start is not None:
                runs.append((lo + (index + run_start) * PAGE, (batch - run_start) * PAGE))
            index += batch
        return runs

    def rss(self, lo: int, hi: int) -> int:
        return sum(length for _, length in self.resident_runs(lo, hi))

    # -- allocator geometry ---------------------------------------------------

    @property
    def can_read_memory(self) -> bool:
        """Whether this process's memory is reachable at all (see the `mem` property for why it may not be).

        The two classifiers below CONFIRM their geometric signature by reading a header word. Without memory
        they fall back to the signature alone, which is weaker but not guesswork: a 64 MB-aligned anonymous rw
        mapping of at most 64 MB is an allocator arena in every layout we have seen, and the confirmation exists
        to reject a coincidence rather than to do the identifying. Callers surface the degradation
        (report_regions prints a caveat), so a number measured this way is never presented as an exact one.
        """
        try:
            self.mem
        except PermissionError:
            return False
        return True

    def is_thread_arena(self, vma: dict) -> bool:
        if vma["path"] or not vma["perm"].startswith("rw"):
            return False
        if vma["lo"] % (64 << 20) != 0 or (vma["hi"] - vma["lo"]) > (64 << 20):
            return False
        try:
            head = self.read(vma["lo"], 8)
        except PermissionError:
            return True  # signature only — see can_read_memory
        return len(head) == 8 and struct.unpack("<Q", head)[0] == vma["lo"] + 0x30

    def is_mmap_chunk(self, vma: dict) -> bool:
        if vma["path"] or not vma["perm"].startswith("rw"):
            return False
        try:
            head = self.read(vma["lo"], 16)
        except PermissionError:
            # No signature to fall back on here: a standalone mmapped chunk is identified ONLY by its header
            # bits, so without memory it is indistinguishable from any other anonymous mapping. Reported as
            # plain anonymous rather than guessed at.
            return False
        if len(head) < 16:
            return False
        prev_size, size = struct.unpack("<QQ", head)
        return prev_size == 0 and bool(size & 0x2) and PAGE < (size & ~0x7) <= (vma["hi"] - vma["lo"])

    def walk_chunks(self, lo: int, hi: int, resync: bool) -> list[tuple[int, int, bool]]:
        """Walk a malloc chunk chain -> [(addr, size, in_use)].

        `resync` is for the brk heap, which the kernel splits into many VMAs (some of them unreadable); on a
        read error we skip to the next page and pick the chain back up rather than abandoning 300 MB.
        """
        out: list[tuple[int, int, bool]] = []
        addr = lo
        while addr + 16 < hi:
            try:
                header = self.read(addr, 16)
            except OSError:
                if not resync:
                    break
                addr = (addr + PAGE) & ~(PAGE - 1)
                continue
            if len(header) < 16:
                if not resync:
                    break
                addr = (addr + PAGE) & ~(PAGE - 1)
                continue
            size = struct.unpack("<Q", header[8:16])[0] & ~0x7
            if size < 32 or addr + size > hi:
                if not resync:
                    break
                addr += 16
                continue
            try:
                following = self.read(addr + size, 16)
            except OSError:
                following = b""
            in_use = True
            if len(following) >= 16:
                in_use = bool(struct.unpack("<Q", following[8:16])[0] & 1)
            out.append((addr, size, in_use))
            addr += size
        return out

    def all_chunks(self) -> list[tuple[int, int, bool]]:
        """Every malloc chunk we can reach: brk heap + thread arenas + standalone mmapped chunks."""
        chunks: list[tuple[int, int, bool]] = []
        heap = [v for v in self.vmas if v["path"] == "[heap]"]
        if heap:
            chunks += self.walk_chunks(min(v["lo"] for v in heap), max(v["hi"] for v in heap), resync=True)
        for vma in self.vmas:
            if not self.is_thread_arena(vma):
                continue
            # First heap of an arena stores malloc_state inline; later heaps do not. Probe both and keep
            # whichever walk covers the mapping.
            best: tuple[int, list] = (0, [])
            for offset in (0x8d0, 0x8c0, 0x8e0, 0x900, 0x40, 0x30):
                walked = self.walk_chunks(vma["lo"] + offset, vma["hi"], resync=False)
                covered = sum(size for _, size, _ in walked)
                if covered > best[0]:
                    best = (covered, walked)
            if best[0] > (vma["hi"] - vma["lo"]) * 0.5:
                chunks += best[1]
        for vma in self.vmas:
            if self.is_mmap_chunk(vma):
                size = struct.unpack("<Q", self.read(vma["lo"], 16)[8:16])[0] & ~0x7
                chunks.append((vma["lo"], size, True))
        return chunks


# -- modes -------------------------------------------------------------------


def report_regions(target: Target) -> None:
    buckets: collections.Counter[str] = collections.Counter()
    counts: collections.Counter[str] = collections.Counter()
    for vma in target.vmas:
        if "r" not in vma["perm"]:
            continue
        resident = target.rss(vma["lo"], vma["hi"])
        if resident == 0:
            continue
        path = vma["path"]
        if path == "[heap]":
            label = "glibc main heap (brk)"
        elif path.startswith("/memfd:doublemapper"):
            label = ".NET JIT code (doublemapper)"
        elif path.startswith("/dev/shm") or path.startswith("/dev/nvidia"):
            label = f"device/shm: {os.path.basename(path)}"
        elif path:
            label = "file-backed (exe / assemblies / .so)"
        elif target.is_thread_arena(vma):
            label = "glibc thread arenas"
        elif target.is_mmap_chunk(vma):
            label = "glibc large mmap chunks"
        elif (vma["hi"] - vma["lo"]) in ((8 << 20), (8 << 20) + PAGE) and resident < (1 << 20):
            label = "thread stacks"
        else:
            # On the game this is the CLR: the GC's committed regions carved out of its 256 GB reservation,
            # plus loader heaps and type-system allocations.
            label = "CLR / other anonymous mmap"
        buckets[label] += resident
        counts[label] += 1

    total = sum(buckets.values())
    print(f"=== PID {target.pid}: RSS by region ({total / (1 << 20):.1f} MB) ===")
    if not target.can_read_memory:
        print("  NOTE: no ptrace access — arenas identified by mapping geometry only, and standalone mmapped")
        print("        chunks are folded into 'CLR / other anonymous mmap'. Re-run under sudo for exact splits.")
    for label, value in buckets.most_common():
        print(f"  {mb(value)}  ({counts[label]:5d})  {label}")


def report_chunks(target: Target) -> None:
    chunks = target.all_chunks()
    used = [c for c in chunks if c[2]]
    free = [c for c in chunks if not c[2]]
    used_bytes = sum(c[1] for c in used)
    free_bytes = sum(c[1] for c in free)
    print(f"=== PID {target.pid}: glibc chunks ===")
    print(f"  used {mb(used_bytes)} in {len(used)} chunks")
    print(f"  free {mb(free_bytes)} in {len(free)} chunks"
          f"   ({free_bytes / max(1, used_bytes + free_bytes):.1%} of walked heap is allocator slack)")
    histogram: collections.Counter[str] = collections.Counter()
    tally: collections.Counter[str] = collections.Counter()
    edges = [(64, "<=64B"), (256, "<=256B"), (1 << 10, "<=1K"), (4 << 10, "<=4K"), (16 << 10, "<=16K"),
             (64 << 10, "<=64K"), (256 << 10, "<=256K"), (1 << 20, "<=1M"), (4 << 20, "<=4M")]
    for _, size, _ in used:
        label = ">4M"
        for limit, name in edges:
            if size <= limit:
                label = name
                break
        histogram[label] += size
        tally[label] += 1
    print("  used bytes by chunk size:")
    for _, name in edges + [(0, ">4M")]:
        if histogram[name]:
            print(f"    {name:>7}: {mb(histogram[name])} ({tally[name]} chunks)")


def collect_images(target: Target) -> tuple[list[dict], int, int]:
    """-> (images, non_image_cow_count, non_image_cow_bytes).

    Finds CowData buffers, then locates the Image object that owns each one by scanning writable memory for
    the buffer's data pointer and validating the surrounding struct against the buffer size.
    """
    cow: dict[int, tuple[int, int, int]] = {}
    for addr, size, in_use in target.all_chunks():
        if size < 4096 or not in_use:
            continue
        header = target.read(addr + 16, 16)
        if len(header) < 16:
            continue
        refcount, payload = struct.unpack("<QQ", header)
        if 1 <= refcount <= 64 and 256 <= payload <= size - 16:
            cow[addr + 32] = (size, refcount, payload)

    pointers = set(cow)
    holders: dict[int, list[int]] = collections.defaultdict(list)
    for vma in target.vmas:
        if not vma["perm"].startswith("rw"):
            continue
        if vma["path"].startswith(("/usr/", "/run/", "/snap/")):
            continue
        for start, length in target.resident_runs(vma["lo"], vma["hi"]):
            offset = 0
            while offset < length:
                span = min(8 << 20, length - offset)
                try:
                    buf = target.read(start + offset, span)
                except OSError:
                    break
                words = len(buf) // 8
                for i, word in enumerate(struct.unpack(f"<{words}Q", buf[:words * 8])):
                    if word in pointers:
                        holders[word].append(start + offset + i * 8)
                offset += span

    images: list[dict] = []
    other_count = 0
    other_bytes = 0
    for pointer, (chunk_size, refcount, payload) in cow.items():
        match = None
        for holder in holders.get(pointer, ()):
            struct_bytes = target.read(holder - 16, 36)
            if len(struct_bytes) < 36:
                continue
            format_index = struct.unpack("<i", struct_bytes[0:4])[0]
            width, height = struct.unpack("<ii", struct_bytes[24:32])
            mipmaps = struct_bytes[32]
            if not 0 <= format_index < len(FORMATS) or mipmaps > 1:
                continue
            if not (0 < width <= 32768 and 0 < height <= 32768):
                continue
            name = FORMATS[format_index]
            if name in BPP:
                base = width * height * BPP[name]
            elif name in BLOCK_BPP:
                base = int(((width + 3) // 4) * ((height + 3) // 4) * 16 * BLOCK_BPP[name] / 1.0)
            else:
                continue
            expected = base if mipmaps == 0 else int(base * 4 / 3)
            if abs(expected - payload) > max(8192, payload * 0.15):
                continue
            match = {
                "format": name, "width": width, "height": height, "mipmaps": bool(mipmaps),
                "payload": payload, "chunk": chunk_size, "refcount": refcount,
                "owners": len(holders.get(pointer, ())),
            }
            break
        if match:
            images.append(match)
        else:
            other_count += 1
            other_bytes += chunk_size
    return images, other_count, other_bytes


def report_images(target: Target) -> None:
    images, other_count, other_bytes = collect_images(target)
    payload = sum(i["payload"] for i in images)
    footprint = sum(i["chunk"] for i in images)
    print(f"=== PID {target.pid}: Godot Image inventory ===")
    print(f"  {len(images)} images   pixel payload {mb(payload)}   heap footprint {mb(footprint)}")
    print(f"  non-image CowData buffers: {other_count} ({mb(other_bytes)})")

    by_format: collections.Counter[str] = collections.Counter()
    bytes_by_format: collections.Counter[str] = collections.Counter()
    for image in images:
        by_format[image["format"]] += 1
        bytes_by_format[image["format"]] += image["payload"]
    print("  by format:")
    for name, count in by_format.most_common():
        marker = "  <- VRAM-compressed (evictable)" if name in VRAM_COMPRESSED else ""
        print(f"    {name:14s} {count:5d} imgs {mb(bytes_by_format[name])}{marker}")

    evictable = sum(i["payload"] for i in images if i["format"] in VRAM_COMPRESSED)
    evictable_count = sum(1 for i in images if i["format"] in VRAM_COMPRESSED)
    print(f"  VRAM-compressed subtotal: {evictable_count} imgs {mb(evictable)}")

    dims: collections.Counter[tuple] = collections.Counter()
    dim_bytes: collections.Counter[tuple] = collections.Counter()
    for image in images:
        key = (image["width"], image["height"], image["format"], image["mipmaps"])
        dims[key] += 1
        dim_bytes[key] += image["payload"]
    print("  top dimensions:")
    for key, count in dims.most_common(12):
        print(f"    {key[0]}x{key[1]} {key[2]} mip={key[3]}: {count:5d} imgs {mb(dim_bytes[key])}")
    print(f"  CowData refcounts: {dict(collections.Counter(i['refcount'] for i in images))}"
          f"   (2 = the dummy renderer's duplicate is a second owner)")


def find_targets() -> list[int]:
    """Locate the running host + headless seats.

    Matches on argv[0]'s basename, NOT a substring of the whole cmdline — otherwise this script (and any shell
    or agent that happens to mention the game) matches itself.
    """
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            argv = open(f"/proc/{entry}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        if argv and os.path.basename(argv[0].decode(errors="ignore")) == "SlayTheSpire2":
            found.append(int(entry))
    return sorted(found)


def describe(pid: int) -> str:
    try:
        cmdline = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="ignore")
        environ = open(f"/proc/{pid}/environ", "rb").read().decode(errors="ignore")
    except OSError:
        return ""
    if "SlayTheSpire2" not in cmdline:
        return "not an STS2 process"
    slot = re.search(r"COUCHCOOP_HEADLESS_SLOT=(\d+)", environ)
    if "--headless" in cmdline:
        return f"headless seat (slot {slot.group(1)})" if slot else "headless"
    return "host"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pids", nargs="*", type=int)
    parser.add_argument("--auto", action="store_true", help="find the running host + headless seats")
    parser.add_argument("--regions", action="store_true")
    parser.add_argument("--chunks", action="store_true")
    parser.add_argument("--images", action="store_true")
    args = parser.parse_args()

    pids = args.pids or (find_targets() if args.auto else [])
    if not pids:
        parser.error("give one or more pids, or --auto to find the running STS2 processes")

    modes = [args.regions, args.chunks, args.images]
    if not any(modes):
        args.regions = args.chunks = args.images = True

    for pid in pids:
        try:
            target = Target(pid)
        except (OSError, PermissionError) as error:
            print(f"PID {pid}: cannot read ({error})", file=sys.stderr)
            continue
        status = open(f"/proc/{pid}/status").read()
        rss = re.search(r"VmRSS:\s+(\d+) kB", status)
        role = describe(pid)
        print(f"\n########## PID {pid} — {role} — VmRSS {int(rss.group(1)) / 1024:.1f} MB ##########")
        # Each mode is guarded on its own: --regions needs no process memory, so a box where only the ptrace
        # modes are refused still gets its region breakdown instead of nothing at all.
        for enabled, report in ((args.regions, report_regions), (args.chunks, report_chunks), (args.images, report_images)):
            if not enabled:
                continue
            try:
                report(target)
            except PermissionError as error:
                print(f"  [{report.__name__}] skipped: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
