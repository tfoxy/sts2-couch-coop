#!/usr/bin/env python3
"""Focused relational tests for the portable renderer benchmark validator."""

import copy
import runpy
import unittest
from pathlib import Path


MODULE = runpy.run_path(str(Path(__file__).with_name("validate-renderer-benchmark-result.py")))
semantic_errors = MODULE["semantic_errors"]
comparison_errors = MODULE["comparison_errors"]


def cell():
    process = {"role": "renderer", "pid": 100, "instance": "renderer-start"}
    milestone = lambda ns: {"timestampNs": str(ns)}
    return {
        "renderer": {"graphicsApi": "webgl", "environmentSha256": "0" * 64},
        "input": {"firstIndex": 1, "lastIndexExclusive": 2},
        "delivery": {"messageCount": 1, "sceneDeltaCount": 1},
        "window": {"startNs": "0", "endNs": "1000000000", "spanMs": 1000},
        "processAccounting": {"included": [process], "excluded": []},
        "measurements": {
            "processCpu": [{**process, "cpu": {"unit": "ms"}}],
            "workloadCompletion": {"value": 900},
        },
        "visualWitness": {"coveredStartNs": "0", "coveredEndNs": "1000000000"},
        "milestones": {
            "firstInput": milestone(0),
            "firstCompletedDraw": milestone(100_000_000),
            "firstActualPresentation": milestone(200_000_000),
            "finalActualPresentation": milestone(900_000_000),
            "finalDeliveredRevision": milestone(800_000_000),
        },
        "validity": {"status": "pass"},
    }


class BenchmarkRelationsTest(unittest.TestCase):
    def test_valid_single_cell_and_pair(self):
        left, right = cell(), cell()
        right["processAccounting"]["included"][0]["pid"] = 101
        right["measurements"]["processCpu"][0]["pid"] = 101
        self.assertEqual(semantic_errors(left), [])
        self.assertEqual(semantic_errors(right), [])
        self.assertEqual(comparison_errors(left, right), [])

    def test_cpu_must_match_included_process(self):
        result = cell()
        result["measurements"]["processCpu"][0]["pid"] = 999
        self.assertIn("process CPU identity is absent from included ledger", semantic_errors(result))

    def test_visual_and_workload_must_cover_window(self):
        result = cell()
        result["visualWitness"]["coveredStartNs"] = "1"
        result["measurements"]["workloadCompletion"]["value"] = 1
        errors = semantic_errors(result)
        self.assertIn("visual witness does not enclose the measured window", errors)
        self.assertIn("workload completion differs from first input to final presentation", errors)

    def test_cross_api_environment_and_input_rejected(self):
        left, right = cell(), copy.deepcopy(cell())
        right["renderer"]["graphicsApi"] = "vulkan"
        right["renderer"]["environmentSha256"] = "1" * 64
        right["input"]["lastIndexExclusive"] = 3
        errors = comparison_errors(left, right)
        self.assertIn("graphics API differs across cells", errors)
        self.assertIn("environment hash differs across cells", errors)
        self.assertIn("input identity differs across cells", errors)

    def test_invalid_verdict_cannot_compare(self):
        left, right = cell(), cell()
        right["validity"]["status"] = "invalid"
        self.assertIn("comparison requires two passing cells", comparison_errors(left, right))


if __name__ == "__main__":
    unittest.main()
