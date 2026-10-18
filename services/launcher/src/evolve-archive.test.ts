// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACT_EVOLVE } from "./evolve-install.js";
const run = promisify(execFile);
const BUILD = String.raw`
import gzip, io, json, pathlib, sys, tarfile, sysconfig
folder, entries, extraction = sys.argv[1:]
archive = pathlib.Path(folder) / "input.tar.gz"
with gzip.open(archive, "wb") as output:
    for spec in json.loads(entries):
        member = tarfile.TarInfo(spec["name"])
        member.size = spec.get("size", len(spec.get("body", "").encode()))
        member.type = spec.get("type", "0").encode()
        member.linkname = spec.get("link", "")
        output.write(member.tobuf())
        body = spec.get("body", "").encode()
        output.write(body)
        output.write(b"\0" * ((-len(body)) % 512))
    output.write(b"\0" * 1024)
sysconfig.get_paths = lambda: {"purelib": str(pathlib.Path(folder) / "site")}
sys.argv = ["extract", str(archive), "fixture"]
exec(extraction)
`;
async function extract(entries: object[], action: (folder: string, error?: Error) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "evolve-archive-test-"));
  let error: Error | undefined;
  try {
    try { await run(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-I", "-c", BUILD, folder, JSON.stringify(entries), EXTRACT_EVOLVE], { timeout: 5_000, maxBuffer: 1024 * 1024 }); }
    catch (reason) { error = reason as Error; }
    await action(folder, error);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
const source = "sciencediscovery-fixture/services/evolve/src/";
test("only regular Evolve source is extracted to the interpreter site directory", async () => {
  await extract([{ name: "sciencediscovery-fixture/README", body: "unrelated" },
    { name: source + "sciencediscovery_evolve/", type: "5" },
    { name: source + "sciencediscovery_evolve/server.py", body: "# fixture\n" }], async (folder, error) => {
    assert.equal(error, undefined); assert.equal(await readFile(join(folder, "site/sciencediscovery_evolve/server.py"), "utf8"), "# fixture\n");
    assert.deepEqual(await readdir(join(folder, "site")), ["sciencediscovery_evolve"]);
  });
});
test("traversal, absolute/wrong-root/backslash paths, links, special files, oversized data and absent entry points are rejected", async () => {
  const entries = [
    { name: source + "../escape", body: "bad" }, { name: "/escape" }, { name: "wrong-root/file" },
    { name: source + "sciencediscovery_evolve\\bad" }, { name: source + "unexpected/file" },
    { name: source + "sciencediscovery_evolve/server.py", type: "2", link: "../../escape" },
    { name: source + "sciencediscovery_evolve/server.py", type: "1", link: "outside" },
    { name: source + "sciencediscovery_evolve/fifo", type: "6" },
    { name: source + "sciencediscovery_evolve/large", size: 65 * 1024 * 1024 },
    { name: source + "sciencediscovery_evolve/large", size: 17 * 1024 * 1024 },
    { name: "sciencediscovery-fixture/no-service" },
  ];
  for (const entry of entries) await extract([entry], async (folder, error) => {
    assert(error, entry.name); assert.match(error.message, /ValueError|ReadError|empty file/);
    assert(!(await readdir(folder)).includes("escape"));
  });
});
