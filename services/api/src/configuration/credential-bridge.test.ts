// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import { DatabaseSync } from "node:sqlite";
import { ConfigurationCredentialBridge, type ConfigurationCredentialBinding } from "./credential-bridge.js";

function harness() {
  const database = new DatabaseSync(":memory:"); const key = randomBytes(32); let now = Date.now();
  const cipher = { encrypt(id: string, secret: string) {
    const iv = randomBytes(12); const encrypt = createCipheriv("aes-256-gcm", key, iv); encrypt.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([encrypt.update(secret, "utf8"), encrypt.final()]);
    return Buffer.concat([iv, encrypt.getAuthTag(), ciphertext]).toString("base64");
  }, decrypt(id: string, encoded: string) {
    const value = Buffer.from(encoded, "base64"); const decrypt = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decrypt.setAAD(Buffer.from(id)); decrypt.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decrypt.update(value.subarray(28)), decrypt.final()]).toString("utf8");
  } };
  const bridge = new ConfigurationCredentialBridge(database, cipher, () => now);
  const binding: ConfigurationCredentialBinding = { sessionId: "session", requestId: "request", revision: 1, target: "https://model.example|model", fieldId: "apiToken" };
  return { database, bridge, binding, cipher, advance(ms: number) { now += ms; }, rows() { return database.prepare("SELECT * FROM configuration_credential_drafts").all(); } };
}

test("CFG-T06/23: drafts and idempotency payload stay encrypted and are isolated by exact binding", () => {
  const h = harness(); const response = h.bridge.provide(h.binding, "sensitive-token", "upload-key");
  assert.equal(h.bridge.read(response.handle, h.binding), "sensitive-token");
  for (const partial of [{ sessionId: "another" }, { requestId: "another" }, { revision: 2 }, { target: "https://elsewhere.example" }, { fieldId: "other" }]) {
    assert.throws(() => h.bridge.read(response.handle, { ...h.binding, ...partial }));
  }
  const raw = [...h.rows(), ...h.database.prepare("SELECT * FROM configuration_credential_uploads").all()];
  assert.equal(JSON.stringify(raw).includes("sensitive-token"), false);
  assert.deepEqual(h.bridge.provide({ ...h.binding }, "sensitive-token", "upload-key"), response);
  assert.throws(() => h.bridge.provide(h.binding, "different-token", "upload-key"), /IDEMPOTENCY_MISMATCH/);
  assert.throws(() => h.bridge.provide({ ...h.binding, sessionId: "another" }, "sensitive-token", "upload-key"), /IDEMPOTENCY_MISMATCH/);
  assert.equal(h.rows().length, 1);
});

test("CFG-T23: replacement invalidates the old handle and its idempotency replay without affecting another request", () => {
  const h = harness(); const first = h.bridge.provide(h.binding, "first", "first-key");
  const otherBinding = { ...h.binding, requestId: "other" }; const other = h.bridge.provide(otherBinding, "unrelated", "other-key");
  const second = h.bridge.provide(h.binding, "second", "second-key");
  assert.throws(() => h.bridge.read(first.handle, h.binding), /EXPIRED/);
  assert.throws(() => h.bridge.provide(h.binding, "first", "first-key"), /EXPIRED/);
  assert.equal(h.bridge.read(second.handle, h.binding), "second");
  assert.equal(h.bridge.read(other.handle, otherBinding), "unrelated");
});

test("CFG-T06/23: expiry and clearing invalidate reads and upload replay", () => {
  const h = harness(); const first = h.bridge.provide(h.binding, "first", "key");
  h.advance(30 * 60_000);
  assert.throws(() => h.bridge.read(first.handle, h.binding), /EXPIRED/);
  assert.throws(() => h.bridge.provide(h.binding, "first", "key"), /EXPIRED/);
  h.bridge.sweep(); assert.equal(h.rows().length, 0);
  assert.equal(h.database.prepare("SELECT * FROM configuration_credential_uploads").all().length, 0);
  const second = h.bridge.provide(h.binding, "second"); h.bridge.clearRequest(h.binding.requestId);
  assert.throws(() => h.bridge.read(second.handle, h.binding), /EXPIRED/);
  const third = h.bridge.provide(h.binding, "third"); h.bridge.clearSession(h.binding.sessionId);
  assert.throws(() => h.bridge.read(third.handle, h.binding), /EXPIRED/);
});

test("CFG-T23: credential revision rebind is monotonic, exact, and idempotent", () => {
  const h = harness(); const response = h.bridge.provide(h.binding, "token");
  assert.throws(() => h.bridge.rebind(response.handle, h.binding, 3), /STALE/);
  h.bridge.rebind(response.handle, h.binding, 2); h.bridge.rebind(response.handle, h.binding, 2);
  assert.throws(() => h.bridge.read(response.handle, h.binding), /EXPIRED/);
  assert.equal(h.bridge.read(response.handle, { ...h.binding, revision: 2 }), "token");
  assert.throws(() => h.bridge.rebind(response.handle, { ...h.binding, revision: 2 }, 1), /STALE/);
  assert.throws(() => h.bridge.rebind(response.handle, { ...h.binding, target: "wrong" }, 2), /EXPIRED/);
});

test("CFG-T23: a bounded validation lease blocks concurrent use and defers deletion while clear revokes access immediately", async () => {
  const h = harness(); const response = h.bridge.provide(h.binding, "token"); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const leased = h.bridge.withLease(response.handle, h.binding, async secret => { assert.equal(secret, "token"); await gate; return "verified"; });
  await assert.rejects(h.bridge.withLease(response.handle, h.binding, async () => "unexpected"), /BUSY/);
  assert.throws(() => h.bridge.rebind(response.handle, h.binding, 2), /BUSY/);
  h.bridge.clearRequest(h.binding.requestId); h.bridge.sweep();
  assert.equal(h.rows().length, 1); assert.throws(() => h.bridge.read(response.handle, h.binding), /EXPIRED/);
  release(); assert.equal(await leased, "verified"); assert.equal(h.rows().length, 0);
});

test("CFG-T23: expired drafts survive only their validation lease and are deleted when it releases", async () => {
  const h = harness(); const response = h.bridge.provide(h.binding, "token"); h.advance(30 * 60_000 - 5_000);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const leased = h.bridge.withLease(response.handle, h.binding, async () => { await gate; });
  h.advance(10_000); h.bridge.sweep(); assert.equal(h.rows().length, 1);
  assert.throws(() => h.bridge.read(response.handle, h.binding), /EXPIRED/);
  release(); await leased; assert.equal(h.rows().length, 0);
});

test("CFG-T23: an expired callback cannot release the later lease on the same draft", async () => {
  const h = harness(); const response = h.bridge.provide(h.binding, "token");
  let releaseFirst!: () => void; let releaseSecond!: () => void;
  const first = h.bridge.withLease(response.handle, h.binding, async () => { await new Promise<void>(resolve => { releaseFirst = resolve; }); });
  h.advance(20_001);
  const second = h.bridge.withLease(response.handle, h.binding, async () => { await new Promise<void>(resolve => { releaseSecond = resolve; }); });
  releaseFirst(); await first;
  await assert.rejects(h.bridge.withLease(response.handle, h.binding, async () => "unexpected"), /BUSY/);
  releaseSecond(); await second;
});

test("CFG-T06: draft replacement rolls back if encrypted idempotency persistence fails", () => {
  const h = harness(); const initial = h.bridge.provide(h.binding, "original");
  const bridge = new ConfigurationCredentialBridge(h.database, { ...h.cipher, encrypt(id, secret) { if (id.startsWith("configuration-upload:")) throw new Error("disk/encryption failure"); return h.cipher.encrypt(id, secret); } });
  assert.throws(() => bridge.provide(h.binding, "replacement", "key"));
  assert.equal(h.bridge.read(initial.handle, h.binding), "original"); assert.equal(h.rows().length, 1);
});
