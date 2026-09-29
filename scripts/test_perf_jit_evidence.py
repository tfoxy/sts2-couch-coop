#!/usr/bin/env python3
"""Failure fixtures for the fixed-period perf/JIT evidence boundary."""

import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location(
    "perf_jit_evidence", Path(__file__).parent / "lib/perf_jit_evidence.py")
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def jit_header():
    return struct.pack("<IIIIIIQQ", 0x4A695444, 1, 40, 62, 0xDEADBEEF, 7, 1, 0)


def load(index=1, start=0x1000, size=0x80, timestamp=10, name="expected"):
    suffix = name.encode() + b"\0" + b"\x90" * size
    return struct.pack("<IIQIIQQQQ", 0, 56 + len(suffix), timestamp,
                       7, 7, start, start, size, index) + suffix


def move(index=1, old=0x1000, new=0x2000, size=0x80, timestamp=20):
    return struct.pack("<IIQIIQQQQQ", 1, 64, timestamp, 7, 7, new, old, new, size, index)


def close(timestamp=30):
    return struct.pack("<IIQ", 3, 16, timestamp)


def sample(ip=0x1010, pid=7, tid=7, identifier=11, cpu=5, period=86_000_000,
           timestamp=100, chain=None):
    chain = (0xFFFFFFFFFFFFFE00, ip) if chain is None else chain
    fields = struct.pack("<QQQQQQQ", identifier, ip, (tid << 32) | pid,
                         timestamp, cpu, period, len(chain))
    return struct.pack("<IHH", 9, 0, 8 + len(fields) + 8 * len(chain)) + fields + struct.pack(f"<{len(chain)}Q", *chain)


def perf_data(*records):
    payload = b"".join(records)
    header = bytearray(72)
    header[:8] = b"PERFILE2"
    struct.pack_into("<QQ", header, 40, 72, len(payload))
    return bytes(header) + payload


class JitEvidenceTests(unittest.TestCase):
    def test_named_only_inside_complete_contemporaneous_range(self):
        records, errors = module.parse_jit_dump(jit_header() + load())
        self.assertEqual(errors, [])
        self.assertEqual(module.code_at(records, 0x1010, 100)[0], "expected")
        self.assertIsNone(module.code_at(records, 0x1080, 100)[0])
        self.assertIsNone(module.code_at(records, 0x1010, 9)[0])

    def test_truncated_and_missing_loads_stay_unknown(self):
        records, errors = module.parse_jit_dump(jit_header() + load()[:-12])
        self.assertEqual(records, [])
        self.assertRegex(errors[0], "truncated")
        self.assertIsNone(module.code_at(records, 0x1010, 100)[0])
        self.assertIsNone(module.code_at([], 0x1010, 100)[0])

    def test_move_requires_matching_old_range_and_close_ends_lifetime(self):
        records, errors = module.parse_jit_dump(jit_header() + load() + move() + close())
        self.assertEqual(errors, [])
        self.assertIsNone(module.code_at(records, 0x1010, 25)[0])
        self.assertEqual(module.code_at(records, 0x2010, 25)[0], "expected")
        self.assertIsNone(module.code_at(records, 0x2010, 30)[0])
        bad, _ = module.parse_jit_dump(jit_header() + load() + move(old=0x3000))
        self.assertIsNone(module.code_at(bad, 0x2010, 25)[0])

    def test_wrong_identity_id_cpu_loss_throttle_and_missing_frame(self):
        records = [sample()]
        samples, counts = module.parse_perf_data(perf_data(*records))
        self.assertEqual(module.validate_perf_samples(samples, counts, {11:5}, 7, 7, 86_000_000), [])
        self.assertIn("wrong PID/TID", " ".join(module.validate_perf_samples(samples, counts, {11:5}, 8, 7, 86_000_000)))
        self.assertIn("wrong event ID/CPU", " ".join(module.validate_perf_samples(samples, counts, {11:0}, 7, 7, 86_000_000)))
        missing, counts = module.parse_perf_data(perf_data(sample(chain=(0xFFFFFFFFFFFFFE00,))))
        self.assertIn("absent/mismatched callchain IP", " ".join(module.validate_perf_samples(missing, counts, {11:5}, 7, 7, 86_000_000)))
        counts.update({2:1, 5:1, 6:1})
        self.assertEqual(module.validate_perf_samples(samples, counts, {11:5}, 7, 7, 86_000_000),
                         ["LOST", "THROTTLE/UNTHROTTLE"])

    def test_event_index_conflict_and_clock_edges(self):
        self.assertEqual(module.perf_event_ids("id: 11 idx: 1 cpu: 5 tid: 7"), {11:5})
        with self.assertRaisesRegex(ValueError, "conflicting"):
            module.perf_event_ids("id: 11 idx: 1 cpu: 5 tid: 7\nid: 11 idx: 2 cpu: 0 tid: 7")
        one = module.parse_perf_data(perf_data(sample(timestamp=103)))[0][0]
        self.assertEqual(module.phase_bucket(one, 100, 200, 3), "boundary")
        self.assertEqual(module.phase_bucket(one, 100, 200, 2), "eligible")
        self.assertEqual(module.phase_bucket(one, 104, 200, 2), "boundary")


if __name__ == "__main__":
    unittest.main()
