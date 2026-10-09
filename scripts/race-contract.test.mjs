// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
test("RACE contract preserves official criteria and reports evaluation errors accurately", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks/deepresearchbench", "-p", "test_*.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});
