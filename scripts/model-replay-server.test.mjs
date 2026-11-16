import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const server = join(process.cwd(), "scripts", "model-replay-server.mjs");

function start(args) {
  const child = spawn(process.execPath, [server, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const line = text.split("\n").find((item) => item.trim());
      if (line) resolve({ child, ready: JSON.parse(line) });
    });
    child.once("error", reject);
    child.once("exit", (code) => code && reject(new Error(`server exited ${code}`)));
  });
  return ready;
}

test("replays recorded response and reports consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-replay-"));
  try {
    await writeFile(join(root, "001.json"), JSON.stringify({
      response: { status: 200, headers: { "content-type": "application/json" }, body: '{"choices":[{"message":{"content":"ok"}}]}' },
    }));
    const { child, ready } = await start(["--capture-dir", root, "--token", "test-token"]);
    try {
      const response = await fetch(ready.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"choices":[{"message":{"content":"ok"}}]}');
      const status = await (await fetch(ready.statusUrl)).json();
      assert.deepEqual(status, { mode: "capture", total: 1, consumed: 1, requests: 1, failures: [] });
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
