#!/usr/bin/env python3
"""Validate portable renderer benchmark cells and optional matched comparisons."""

import argparse
import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError as exc:
    raise SystemExit("Install Python jsonschema to validate renderer benchmark results") from exc


SCHEMA = Path(__file__).resolve().parents[1] / "docs/renderer-benchmark-result.schema.json"


def process_key(process):
    return process["role"], process["pid"], process["instance"]


def semantic_errors(cell):
    errors = []
    input_record = cell["input"]
    delivery = cell["delivery"]
    if input_record["lastIndexExclusive"] - input_record["firstIndex"] != delivery["messageCount"]:
        errors.append("delivered message count differs from input slice length")

    window = cell["window"]
    start, end = window["startNs"], window["endNs"]
    if start is not None and end is not None:
        start, end = int(start), int(end)
        if end <= start:
            errors.append("window endpoints are reversed")
        elif abs((end - start) / 1_000_000 - window["spanMs"]) > 1:
            errors.append("window span differs from mapped endpoints by more than 1 ms")

    included = [process_key(p) for p in cell["processAccounting"]["included"]]
    excluded = [process_key(p) for p in cell["processAccounting"]["excluded"]]
    measured = [process_key(p) for p in cell["measurements"]["processCpu"]]
    if len(included) != len(set(included)) or len(excluded) != len(set(excluded)):
        errors.append("duplicate process ledger identity")
    if set(included) & set(excluded):
        errors.append("process identity is both included and excluded")
    if len(measured) != len(set(measured)):
        errors.append("duplicate process CPU identity")
    if set(measured) - set(included):
        errors.append("process CPU identity is absent from included ledger")

    if cell["validity"]["status"] == "pass":
        if set(measured) != set(included):
            errors.append("pass requires CPU for every included process")
        if any(p["cpu"]["unit"] != "ms" for p in cell["measurements"]["processCpu"]):
            errors.append("process CPU must use scheduled milliseconds")
        visual = cell["visualWitness"]
        if start is None or end is None:
            errors.append("pass requires mapped window endpoints")
        else:
            visual_start, visual_end = int(visual["coveredStartNs"]), int(visual["coveredEndNs"])
            if visual_start > start or visual_end < end:
                errors.append("visual witness does not enclose the measured window")
            for name in ("firstInput", "firstCompletedDraw", "firstActualPresentation",
                         "finalActualPresentation", "finalDeliveredRevision"):
                value = cell["milestones"][name]["timestampNs"]
                if value is not None and not start <= int(value) <= end:
                    errors.append(f"{name} is outside the measured window")
        milestones = cell["milestones"]
        first = milestones["firstInput"]["timestampNs"]
        final = milestones["finalActualPresentation"]["timestampNs"]
        if first is not None and final is not None:
            observed = (int(final) - int(first)) / 1_000_000
            if observed < 0 or abs(observed - cell["measurements"]["workloadCompletion"]["value"]) > 1:
                errors.append("workload completion differs from first input to final presentation")
        if delivery["sceneDeltaCount"] and (first is None or final is None):
            errors.append("pass with scene deltas requires first input and final presentation times")
    return errors


def comparison_errors(left, right):
    errors = []
    if left["validity"]["status"] != "pass" or right["validity"]["status"] != "pass":
        errors.append("comparison requires two passing cells")
    if left["renderer"]["graphicsApi"] != right["renderer"]["graphicsApi"]:
        errors.append("graphics API differs across cells")
    if left["renderer"]["environmentSha256"] != right["renderer"]["environmentSha256"]:
        errors.append("environment hash differs across cells")
    if left["input"] != right["input"]:
        errors.append("input identity differs across cells")
    roles = lambda cell: sorted(p["role"] for p in cell["processAccounting"]["included"])
    if roles(left) != roles(right):
        errors.append("included process roles differ across cells")
    return errors


def load_and_validate(path, validator):
    cell = json.loads(path.read_text())
    errors = [f"schema {'.'.join(map(str, error.path))}: {error.message}"
              for error in validator.iter_errors(cell)]
    if not errors:
        errors.extend(semantic_errors(cell))
    return cell, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cell", type=Path)
    parser.add_argument("--compare", type=Path, help="second passing cell to check for matched input and environment")
    args = parser.parse_args()
    schema = json.loads(SCHEMA.read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    left, errors = load_and_validate(args.cell, validator)
    if args.compare:
        right, right_errors = load_and_validate(args.compare, validator)
        errors += [f"{args.compare}: {error}" for error in right_errors]
        if not errors:
            errors += comparison_errors(left, right)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    if args.compare:
        print("comparable passing benchmark cells; CPU effect not assessed")
    else:
        print(f"valid benchmark record; verdict={left['validity']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
