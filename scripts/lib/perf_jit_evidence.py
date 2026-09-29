"""Conservative, read-only joins for perf samples and Linux jitdump code objects.

An IP receives a name only when a complete LOAD/MOVE record owns its address
at the sample timestamp. Truncated records and missing frames remain unknown.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
import struct
from pathlib import Path


@dataclass(frozen=True)
class JitRecord:
    kind: str
    timestamp_ns: int
    code_index: int | None = None
    start: int | None = None
    size: int | None = None
    old_start: int | None = None
    name: str | None = None


@dataclass(frozen=True)
class PerfSample:
    offset: int
    identifier: int
    ip: int
    pid: int
    tid: int
    timestamp_ns: int
    cpu: int
    period: int
    callchain: tuple[int, ...]

    @property
    def frames(self) -> tuple[int, ...]:
        # PERF_CONTEXT_* markers delimit callchain contexts; they are not IPs.
        return tuple(ip for ip in self.callchain if ip < (1 << 64) - 4096)


def parse_jit_dump(data: bytes) -> tuple[list[JitRecord], list[str]]:
    if len(data) < 40:
        raise ValueError("short jitdump header")
    magic, version, header_size, *_ = struct.unpack_from("<IIIIIIQQ", data)
    if magic != 0x4A695444 or version != 1 or header_size < 40 or header_size > len(data):
        raise ValueError("invalid jitdump header")
    offset = header_size
    records: list[JitRecord] = []
    errors: list[str] = []
    while offset < len(data):
        if offset + 16 > len(data):
            errors.append(f"truncated record header at {offset:#x}")
            break
        kind, size, timestamp = struct.unpack_from("<IIQ", data, offset)
        if size < 16 or offset + size > len(data):
            errors.append(f"truncated/invalid record at {offset:#x}: type={kind} size={size}")
            break
        if kind == 0:  # JIT_CODE_LOAD
            if size < 57:
                errors.append(f"short LOAD at {offset:#x}")
            else:
                _, _, _, start, code_size, index = struct.unpack_from("<IIQQQQ", data, offset + 16)
                name_end = data.find(b"\0", offset + 56, offset + size)
                if name_end < 0 or not code_size or start + code_size > 1 << 64:
                    errors.append(f"bad LOAD range/name at {offset:#x}")
                else:
                    records.append(JitRecord("load", timestamp, index, start, code_size,
                                             name=data[offset + 56:name_end].decode("utf-8", "replace")))
        elif kind == 1:  # JIT_CODE_MOVE
            if size < 64:
                errors.append(f"short MOVE at {offset:#x}")
            else:
                _, _, _, old, start, code_size, index = struct.unpack_from("<IIQQQQQ", data, offset + 16)
                if not code_size or start + code_size > 1 << 64:
                    errors.append(f"bad MOVE range at {offset:#x}")
                else:
                    records.append(JitRecord("move", timestamp, index, start, code_size, old))
        elif kind == 3:  # JIT_CODE_CLOSE
            records.append(JitRecord("close", timestamp))
        offset += size
    return records, errors


def code_at(records: list[JitRecord], ip: int, timestamp_ns: int) -> tuple[str | None, str]:
    live: dict[int, JitRecord] = {}
    for record in sorted(records, key=lambda r: r.timestamp_ns):
        if record.timestamp_ns > timestamp_ns:
            break
        if record.kind == "close":
            live.clear()
        elif record.kind == "load":
            live[record.code_index] = record
        elif record.kind == "move":
            previous = live.get(record.code_index)
            if previous and previous.start == record.old_start and previous.size == record.size:
                live[record.code_index] = JitRecord("load", record.timestamp_ns,
                                                    record.code_index, record.start,
                                                    record.size, name=previous.name)
            else:
                live.pop(record.code_index, None)
    hits = [r for r in live.values() if r.start <= ip < r.start + r.size]
    if len(hits) == 1:
        return hits[0].name, "contemporaneous JIT range"
    return None, "ambiguous overlapping JIT ranges" if hits else "no contemporaneous JIT range"


def parse_perf_data(data: bytes) -> tuple[list[PerfSample], dict[int, int]]:
    if len(data) < 72 or data[:8] != b"PERFILE2":
        raise ValueError("invalid perf.data header")
    offset, length = struct.unpack_from("<QQ", data, 40)
    if offset < 72 or offset + length > len(data):
        raise ValueError("invalid perf data section")
    end = offset + length
    samples: list[PerfSample] = []
    counts: dict[int, int] = {}
    while offset < end:
        if offset + 8 > end:
            raise ValueError("short perf record header")
        kind, _, size = struct.unpack_from("<IHH", data, offset)
        if size < 8 or offset + size > end:
            raise ValueError(f"bad perf record extent at {offset:#x}")
        counts[kind] = counts.get(kind, 0) + 1
        if kind == 9:  # PERF_RECORD_SAMPLE with the pinned sample_type layout
            if size < 64:
                raise ValueError(f"short SAMPLE at {offset:#x}")
            ident, ip, pidtid, time, cpuword, period, depth = struct.unpack_from(
                "<QQQQQQQ", data, offset + 8)
            if depth > (size - 64) // 8:
                raise ValueError(f"bad callchain extent at {offset:#x}")
            chain = struct.unpack_from(f"<{depth}Q", data, offset + 64)
            samples.append(PerfSample(offset, ident, ip, pidtid & 0xFFFFFFFF,
                                      pidtid >> 32, time, cpuword & 0xFFFFFFFF,
                                      period, chain))
        offset += size
    return samples, counts


def perf_event_ids(raw_dump: str) -> dict[int, int]:
    """Return identifier -> CPU from perf script -D's initial event ID index."""
    found = re.findall(r"id:\s+(\d+)\s+idx:\s+\d+\s+cpu:\s+(\d+)\s+tid:\s+\d+", raw_dump)
    ids: dict[int, int] = {}
    for identifier, cpu in found:
        identifier, cpu = int(identifier), int(cpu)
        if identifier in ids and ids[identifier] != cpu:
            raise ValueError("conflicting event ID/CPU map")
        ids[identifier] = cpu
    return ids


def validate_perf_samples(samples: list[PerfSample], counts: dict[int, int],
                          ids: dict[int, int], pid: int, tid: int, period: int) -> list[str]:
    failures: list[str] = []
    if counts.get(2, 0):
        failures.append("LOST")
    if counts.get(5, 0) or counts.get(6, 0):
        failures.append("THROTTLE/UNTHROTTLE")
    if not samples:
        failures.append("no samples")
    for sample in samples:
        if sample.pid != pid or sample.tid != tid:
            failures.append(f"wrong PID/TID at {sample.offset:#x}")
        if sample.identifier not in ids or ids[sample.identifier] != sample.cpu:
            failures.append(f"wrong event ID/CPU at {sample.offset:#x}")
        if sample.period != period:
            failures.append(f"wrong period at {sample.offset:#x}")
        if not sample.frames or sample.frames[0] != sample.ip:
            failures.append(f"absent/mismatched callchain IP at {sample.offset:#x}")
    return failures


def phase_bucket(sample: PerfSample, start_ns: int, end_ns: int, guard_ns: int) -> str:
    if end_ns <= start_ns or guard_ns < 0:
        raise ValueError("invalid phase edge or guard")
    if start_ns + guard_ns < sample.timestamp_ns < end_ns - guard_ns:
        return "eligible"
    if (start_ns - guard_ns <= sample.timestamp_ns <= start_ns + guard_ns or
            end_ns - guard_ns <= sample.timestamp_ns <= end_ns + guard_ns):
        return "boundary"
    return "outside"


def load_jit_dump(path: Path) -> tuple[list[JitRecord], list[str]]:
    return parse_jit_dump(path.read_bytes())
