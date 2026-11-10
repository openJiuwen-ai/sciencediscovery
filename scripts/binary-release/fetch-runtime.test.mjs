import { createTest } from "../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";


import { binaryCacheUrl, downloadRuntimeArchive, loadManifest, resolveRuntime } from "./fetch-runtime.mjs";

async function fixture(context) {
  const parent = resolve(".ci-results/binary-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fetch-runtime-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("uses a Python runtime mirror without changing the pinned archive", async () => {
  const manifest = await loadManifest();
  const direct = resolveRuntime(manifest, "python", "x86_64");
  const mirrored = resolveRuntime(
    manifest,
    "python",
    "x86_64",
    "https://registry.npmmirror.com/-/binary/python-build-standalone/",
  );

  assert.equal(
    mirrored.url,
    `https://registry.npmmirror.com/-/binary/python-build-standalone/${manifest.python.release}/${direct.filename}`,
  );
  assert.equal(mirrored.filename, direct.filename);
  assert.equal(mirrored.sha256, direct.sha256);
  assert.equal(mirrored.version, direct.version);
});

test("keeps Node runtime downloads on the manifest base URL", async () => {
  const manifest = await loadManifest();
  const runtime = resolveRuntime(manifest, "node", "x86_64");

  assert.equal(
    runtime.url,
    `${manifest.node.baseUrl}/${manifest.node.version}/${runtime.filename}`,
  );
});

test("percent-encodes cache object names", () => {
  assert.equal(
    binaryCacheUrl("https://cache.example/toolchains/v1", "cpython-3.12.13+20260805.tar.gz"),
    "https://cache.example/toolchains/v1/cpython-3.12.13%2B20260805.tar.gz",
  );
});

test("downloads a verified runtime from the remote cache before the authoritative source", async (context) => {
  const root = await fixture(context);
  const payload = Buffer.from("cached runtime");
  const entry = {
    filename: "runtime.tar.xz",
    sha256: createHash("sha256").update(payload).digest("hex"),
    url: "https://source.example/runtime.tar.xz",
  };
  const requested = [];
  const archive = await downloadRuntimeArchive(entry, root, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1",
    fetchImplementation: async (url) => {
      requested.push(url);
      return new Response(payload, { status: 200 });
    },
  });

  assert.deepEqual(requested, ["https://cache.example/toolchains/v1/runtime.tar.xz"]);
  assert.deepEqual(await readFile(archive), payload);
});

test("falls back to the verified source when the remote cache object is missing", async (context) => {
  const root = await fixture(context);
  const payload = Buffer.from("source runtime");
  const entry = {
    filename: "runtime.tar.xz",
    sha256: createHash("sha256").update(payload).digest("hex"),
    url: "https://source.example/runtime.tar.xz",
  };
  const requested = [];
  const archive = await downloadRuntimeArchive(entry, root, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1/",
    fetchImplementation: async (url) => {
      requested.push(url);
      return url.includes("cache.example")
        ? new Response("missing", { status: 404 })
        : new Response(payload, { status: 200 });
    },
  });

  assert.deepEqual(requested, [
    "https://cache.example/toolchains/v1/runtime.tar.xz",
    "https://source.example/runtime.tar.xz",
  ]);
  assert.deepEqual(await readFile(archive), payload);
});

test("cache-only runtime downloads fail without contacting the source", async (context) => {
  const root = await fixture(context);
  const requested = [];
  const entry = {
    filename: "runtime.tar.xz",
    sha256: "0".repeat(64),
    url: "https://source.example/runtime.tar.xz",
  };

  await assert.rejects(
    downloadRuntimeArchive(entry, root, {
      binaryCacheBaseUrl: "https://cache.example/toolchains/v1",
      binaryCacheOnly: true,
      fetchImplementation: async (url) => {
        requested.push(url);
        return new Response("missing", { status: 404 });
      },
    }),
    /Required binary cache object is missing or invalid/,
  );
  assert.deepEqual(requested, ["https://cache.example/toolchains/v1/runtime.tar.xz"]);
});

test("a stalled runtime download fails with one readable line", async (context) => {
  const root = await fixture(context);
  const entry = {
    filename: "runtime.tar.xz",
    sha256: "0".repeat(64),
    url: "https://source.example/runtime.tar.xz",
  };
  // A 200 whose body sends one chunk and then nothing.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
  });

  await assert.rejects(
    downloadRuntimeArchive(entry, root, {
      stallMs: 200,
      fetchImplementation: async () => new Response(body, { status: 200 }),
    }),
    /external asset download too slow: 1\.0 KB in [\d.]+ s, then no data for 0\.2 s: https:\/\/source\.example\/runtime\.tar\.xz/,
  );
});

test("a trickle below the rate floor fails instead of waiting for the caller timeout", async (context) => {
  const root = await fixture(context);
  const entry = {
    filename: "runtime.tar.xz",
    sha256: "0".repeat(64),
    url: "https://source.example/runtime.tar.xz",
  };
  // 512 KiB arrives at once, so the floor is checked immediately; a floor far
  // above the observed rate is the trickle the job would otherwise sit on.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
    },
  });

  await assert.rejects(
    downloadRuntimeArchive(entry, root, {
      stallMs: 0,
      minBytesPerSecond: 1_000_000_000,
      fetchImplementation: async () => new Response(body, { status: 200 }),
    }),
    /external asset download too slow: 512\.0 KB in [\d.]+ s \([\d.]+ KB\/s, below the \d+\.\d KB\/s floor\): https:\/\/source\.example\/runtime\.tar\.xz/,
  );
});

test("reuses a verified local archive without any request", async (context) => {
  const root = await fixture(context);
  const payload = Buffer.from("local runtime");
  const entry = {
    filename: "runtime.tar.xz",
    sha256: createHash("sha256").update(payload).digest("hex"),
    url: "https://source.example/runtime.tar.xz",
  };
  await writeFile(join(root, entry.filename), payload);
  let requests = 0;

  const archive = await downloadRuntimeArchive(entry, root, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1",
    fetchImplementation: async () => {
      requests += 1;
      return new Response("unexpected", { status: 500 });
    },
  });

  assert.equal(requests, 0);
  assert.equal(archive, join(root, entry.filename));
});
