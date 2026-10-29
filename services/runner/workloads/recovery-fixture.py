#!/usr/bin/env python3
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License").

"""Offline, deterministic recovery example; no model or accelerator is required.

Place this script, input.json (four integers), and config.json ({"multiplier": 2})
in a workspace. Run `python3 recovery-fixture.py initial` to fail after two units,
then `python3 recovery-fixture.py resume` through the controlled recovery path.
`clean` computes the same output without failure. The Runner supplies
SCIENCEDISCOVERY_EXECUTION_ID. Metadata is evidence, never an execution request.
"""

import hashlib
import json
import os
from pathlib import Path
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def atomic_json(path, value):
    destination = Path(path)
    temporary = destination.with_name(destination.name + ".staging")
    with temporary.open("wb") as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(destination)


def file_evidence(path):
    data = Path(path).read_bytes()
    return {"path": path, "sha256": digest(data), "size": len(data)}


def event(name):
    with Path("executed-units.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(name) + "\n")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("initial", "resume", "clean"):
        raise ValueError("Expected initial, resume, or clean")
    execution_id = os.environ.get("SCIENCEDISCOVERY_EXECUTION_ID")
    if not execution_id:
        raise ValueError("SCIENCEDISCOVERY_EXECUTION_ID is required")
    mode = sys.argv[1]
    inputs = json.loads(Path("input.json").read_text())
    config = json.loads(Path("config.json").read_text())
    if (not isinstance(inputs, list) or len(inputs) != 4
            or any(type(value) is not int for value in inputs)
            or type(config.get("multiplier")) is not int):
        raise ValueError("Expected four integer inputs and an integer multiplier")
    dependencies = [
        {"name": "input", "kind": "input", **file_evidence("input.json")},
        {"name": "configuration", "kind": "configuration", **file_evidence("config.json")},
        {"name": "program", "kind": "program", **file_evidence("recovery-fixture.py")},
    ]
    fingerprints = {item["name"]: item["sha256"] for item in dependencies}
    if mode == "resume":
        checkpoint = json.loads(Path("checkpoint.json").read_text())
        if (checkpoint.get("formatVersion") != 1 or checkpoint.get("completed") != [0, 1]
                or checkpoint.get("fingerprints") != fingerprints
                or checkpoint.get("values") != [value * value * config["multiplier"] for value in inputs[:2]]):
            raise ValueError("Invalid or incompatible checkpoint")
        values = checkpoint["values"]
        start = 2
    else:
        event("prepare")
        atomic_json("prepared.json", inputs)
        values = []
        start = 0

    for unit in range(start, 4):
        if mode == "initial" and unit == 2:
            # This incomplete output is deliberately not a reusable checkpoint.
            Path("unit-3.partial").write_text('{"unfinished":', encoding="utf-8")
            checkpoint = {"formatVersion": 1, "completed": [0, 1],
                          "values": values, "fingerprints": fingerprints}
            atomic_json("checkpoint.json", checkpoint)
            assert json.loads(Path("checkpoint.json").read_text()) == checkpoint
            atomic_json("recovery.json", {
                "schemaVersion": 1,
                "executionId": execution_id,
                "adapter": {"id": "deterministic-four-unit-fixture", "version": "1"},
                "workUnits": [{"id": f"unit-{index + 1}", "state": state} for index, state in
                              enumerate(["completed", "completed", "failed", "not_started"])],
                "failure": {"workUnitId": "unit-3", "reason": "Injected fixture failure after two complete units"},
                "objects": [
                    {"id": "checkpoint", "role": "checkpoint", "state": "complete",
                     "validation": {"status": "verified", "validatorId": "fixture-json-v1"},
                     **file_evidence("checkpoint.json")},
                    {"id": "partial-unit", "role": "diagnostic", "state": "partial",
                     "validation": {"status": "unverified"}, **file_evidence("unit-3.partial")},
                ],
                "continuation": {"capability": "supported", "points": [{
                    "id": "continue-units", "mode": "resume", "entryPointId": "fixture.resume.v1",
                    "codeDigest": digest(b"python3 recovery-fixture.py resume"), "cwd": ".",
                    "requiredObjectIds": ["checkpoint"], "requiredInputs": dependencies,
                    "prerequisites": [],
                }]},
            })
            print("Injected failure; units 1 and 2 have a complete checkpoint", file=sys.stderr)
            return 7
        event(f"unit-{unit + 1}")
        values.append(inputs[unit] * inputs[unit] * config["multiplier"])

    atomic_json("result.json", {"values": values, "total": sum(values)})
    print(json.dumps({"completed": 4, "total": sum(values)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
