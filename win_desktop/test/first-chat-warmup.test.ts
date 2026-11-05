// First-chat warmup decisions. Pure functions + fetch injection.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_CHAT_WARMUP_PATH, FIRST_CHAT_WARMUP_TIMEOUT_MS,
  firstChatWarmupHeaders, firstChatWarmupUrl, runFirstChatWarmup,
} from "../src/first-chat-warmup.ts";

test("warmup URL keeps the origin and drops the fragment", () => {
  assert.equal(
    firstChatWarmupUrl("http://127.0.0.1:4310/#token=abc"),
    `http://127.0.0.1:4310${FIRST_CHAT_WARMUP_PATH}`,
  );
  assert.equal(firstChatWarmupUrl("http://127.0.0.1:4310"), `http://127.0.0.1:4310${FIRST_CHAT_WARMUP_PATH}`);
});

test("warmup headers carry a trimmed bearer token, empty without one", () => {
  assert.deepEqual(firstChatWarmupHeaders(" abc "), { authorization: "Bearer abc" });
  assert.deepEqual(firstChatWarmupHeaders(null), {});
  assert.deepEqual(firstChatWarmupHeaders("   "), {});
});

test("runFirstChatWarmup asks the catalog endpoint and returns the status", async () => {
  const seen: { url: string; headers: Record<string, string>; signal: AbortSignal | null }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: (init?.signal ?? null) as AbortSignal | null,
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const status = await runFirstChatWarmup("http://127.0.0.1:4310", "tok");
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, `http://127.0.0.1:4310${FIRST_CHAT_WARMUP_PATH}`);
    assert.equal(seen[0]!.headers.authorization, "Bearer tok");
    assert.ok(seen[0]!.signal instanceof AbortSignal, "a timeout aborts a hung catalog");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runFirstChatWarmup surfaces the fetch failure to the caller", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  try {
    await assert.rejects(runFirstChatWarmup("http://127.0.0.1:4310", null), /boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("warmup timeout is bounded", () => {
  assert.ok(FIRST_CHAT_WARMUP_TIMEOUT_MS <= 120_000, "must stay within the startup budget");
  assert.ok(FIRST_CHAT_WARMUP_TIMEOUT_MS >= 5_000, "a cold catalog spawn needs room");
});
