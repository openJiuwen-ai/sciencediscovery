// Port-epoch decisions. Pure functions only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  epochFromEnv, firstFreeEpoch, healthUrlForPorts, MAX_PORT_EPOCH,
  portsForEpoch, probeHealthyEpoch, stackEnvForPorts, uiUrlForPorts,
} from "../src/ports.ts";

test("epoch 0 is the stack default contract", () => {
  const p = portsForEpoch(0);
  assert.equal(p.publicPort, 4310);
  assert.equal(p.runnerPort, 4311);
  assert.equal(p.legacyPort, 4410);
  assert.equal(p.memoryGraphPort, 17674);
  assert.equal(p.evolvePort, 4313);
  assert.deepEqual(stackEnvForPorts(p), {}); // nothing overridden at epoch 0
  assert.equal(uiUrlForPorts(p), "http://127.0.0.1:4310");
  assert.equal(healthUrlForPorts(p), "http://127.0.0.1:4410/api/health");
});

test("epoch N shifts all three ports together", () => {
  const p = portsForEpoch(3);
  assert.equal(p.publicPort, 4313);
  assert.equal(p.runnerPort, 4314);
  assert.equal(p.legacyPort, 4413);
  assert.equal(stackEnvForPorts(p).SCIENCE_AGENT_PORT, "4313");
  assert.equal(stackEnvForPorts(p).SCIENCE_AGENT_RUNNER_PORT, "4314");
  assert.equal(stackEnvForPorts(p).SCIENCE_AGENT_LEGACY_PORT, "4413");
});

test("epoch N shifts memory-graph and evolve too, URL tracking the port", () => {
  const p = portsForEpoch(1);
  assert.equal(p.memoryGraphPort, 17675);
  assert.equal(p.evolvePort, 4314);
  const env = stackEnvForPorts(p);
  assert.equal(env.SCIENCE_AGENT_MEMORY_GRAPH_PORT, "17675");
  assert.equal(env.SCIENCE_AGENT_MEMORY_GRAPH_URL, "http://127.0.0.1:17675");
  assert.equal(env.SCIENCE_AGENT_EVOLVE_PORT, "4314");
});

test("epochFromEnv: pinned, garbage and out-of-range", () => {
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: "2" }), 2);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: " 5 " }), 5);
  assert.equal(epochFromEnv({}), null);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: "" }), null);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: "abc" }), null);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: "-1" }), null);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: String(MAX_PORT_EPOCH + 1) }), null);
  assert.equal(epochFromEnv({ SD_SHELL_PORT_EPOCH: "1.5" }), null);
});

test("probeHealthyEpoch finds the running epoch", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).includes(":4412/")) return { ok: true } as Response;
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const epoch = await probeHealthyEpoch(fetchImpl, 10, 100);
  assert.equal(epoch, 2);
  assert.equal(calls.length, 3); // stopped probing once found
});

test("probeHealthyEpoch returns null when nothing listens", async () => {
  const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  assert.equal(await probeHealthyEpoch(fetchImpl, 5, 100), null);
});

test("firstFreeEpoch skips epochs with any occupied port", async () => {
  const occupied = new Set([4310, 4312, 4411]); // epoch0 public, epoch2 public, epoch1 legacy
  const epoch = await firstFreeEpoch((port) => !occupied.has(port), 10);
  assert.equal(epoch, 3);
});

test("a busy memory-graph port pushes the epoch even when 4310-family is free (field case)", async () => {
  // An old instance's memory-graph held 17674 while every epoch
  // port was free — the stack died on bind. The epoch decision must see it.
  const occupied = new Set([17674]);
  const epoch = await firstFreeEpoch((port) => !occupied.has(port), 10);
  assert.equal(epoch, 1);
});

test("firstFreeEpoch returns null when every epoch is blocked", async () => {
  const epoch = await firstFreeEpoch(() => false, 4);
  assert.equal(epoch, null);
});
