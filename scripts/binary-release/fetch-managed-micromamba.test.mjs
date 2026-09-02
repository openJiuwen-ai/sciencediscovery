import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  acquireManagedMicromambaBytes,
  condaPackageUrl,
  downloadBytesWithRetry,
} from "../fetch-managed-micromamba.mjs";

const mirrorRelease = {
  condaPackage: {
    cacheFilename: "micromamba-2.8.1-0-linux-aarch64.tar.bz2",
    filename: "micromamba-2.8.1-0.tar.bz2",
    sha256: createHash("sha256").update("archive").digest("hex"),
    subdir: "linux-aarch64",
  },
  runtimeArch: "arm64",
  url: "https://github.example/micromamba-linux-aarch64",
};

test("managed micromamba download retries transient HTTP failures", async () => {
  let calls = 0;
  const bytes = await downloadBytesWithRetry("https://example.invalid/micromamba", {
    fetchImplementation: async () => {
      calls += 1;
      if (calls < 3) return new Response("busy", { status: 503 });
      return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
    },
    retryDelayMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(calls, 3);
  assert.deepEqual(bytes, Buffer.from([1, 2, 3]));
});

test("managed micromamba download does not retry permanent HTTP failures", async () => {
  let calls = 0;
  await assert.rejects(
    downloadBytesWithRetry("https://example.invalid/micromamba", {
      fetchImplementation: async () => {
        calls += 1;
        return new Response("missing", { status: 404 });
      },
      retryDelayMs: 0,
      timeoutMs: 1_000,
    }),
    /download failed \(404\)/,
  );

  assert.equal(calls, 1);
});

test("managed micromamba download uses and verifies a pinned conda mirror package", async () => {
  const expectedBinary = Buffer.from("verified micromamba binary");
  let downloadedUrl = "";
  let extractedArchive;
  const bytes = await acquireManagedMicromambaBytes(mirrorRelease, undefined, {
    condaMirrorBaseUrl: "https://mirrors.example/conda-forge/",
    downloadImplementation: async (url) => {
      downloadedUrl = url;
      return Buffer.from("archive");
    },
    extractImplementation: async (archive) => {
      extractedArchive = archive;
      return expectedBinary;
    },
  });

  assert.equal(downloadedUrl, "https://mirrors.example/conda-forge/linux-aarch64/micromamba-2.8.1-0.tar.bz2");
  assert.deepEqual(extractedArchive, Buffer.from("archive"));
  assert.deepEqual(bytes, expectedBinary);
});

test("managed micromamba checks the remote cache before the conda mirror", async () => {
  const expectedBinary = Buffer.from("verified micromamba binary");
  const requested = [];
  const bytes = await acquireManagedMicromambaBytes(mirrorRelease, undefined, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1/",
    condaMirrorBaseUrl: "https://mirrors.example/conda-forge",
    downloadImplementation: async (url) => {
      requested.push(url);
      return Buffer.from("archive");
    },
    extractImplementation: async () => expectedBinary,
  });

  assert.deepEqual(requested, [
    "https://cache.example/toolchains/v1/micromamba-2.8.1-0-linux-aarch64.tar.bz2",
  ]);
  assert.deepEqual(bytes, expectedBinary);
});

test("managed micromamba checks the remote cache when no conda mirror is configured", async () => {
  const expectedBinary = Buffer.from("verified micromamba binary");
  const requested = [];
  const bytes = await acquireManagedMicromambaBytes(mirrorRelease, undefined, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1/",
    downloadImplementation: async (url) => {
      requested.push(url);
      return Buffer.from("archive");
    },
    extractImplementation: async () => expectedBinary,
  });

  assert.deepEqual(requested, [
    "https://cache.example/toolchains/v1/micromamba-2.8.1-0-linux-aarch64.tar.bz2",
  ]);
  assert.deepEqual(bytes, expectedBinary);
});

test("managed micromamba falls back to the upstream binary after a cache miss without a mirror", async () => {
  const expectedBinary = Buffer.from("upstream micromamba binary");
  const requested = [];
  const bytes = await acquireManagedMicromambaBytes(mirrorRelease, undefined, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1",
    downloadImplementation: async (url) => {
      requested.push(url);
      if (url.includes("cache.example")) throw new Error("missing");
      return expectedBinary;
    },
    extractImplementation: async () => {
      throw new Error("an upstream binary must not be extracted as a conda package");
    },
  });

  assert.deepEqual(requested, [
    "https://cache.example/toolchains/v1/micromamba-2.8.1-0-linux-aarch64.tar.bz2",
    mirrorRelease.url,
  ]);
  assert.deepEqual(bytes, expectedBinary);
});

test("managed micromamba falls back to the conda mirror after a remote cache miss", async () => {
  const requested = [];
  await acquireManagedMicromambaBytes(mirrorRelease, undefined, {
    binaryCacheBaseUrl: "https://cache.example/toolchains/v1",
    condaMirrorBaseUrl: "https://mirrors.example/conda-forge",
    downloadImplementation: async (url) => {
      requested.push(url);
      if (url.includes("cache.example")) throw new Error("missing");
      return Buffer.from("archive");
    },
    extractImplementation: async () => Buffer.from("verified micromamba binary"),
  });

  assert.deepEqual(requested, [
    "https://cache.example/toolchains/v1/micromamba-2.8.1-0-linux-aarch64.tar.bz2",
    "https://mirrors.example/conda-forge/linux-aarch64/micromamba-2.8.1-0.tar.bz2",
  ]);
});

test("managed micromamba download rejects a changed conda mirror package before extraction", async () => {
  let extracted = false;
  await assert.rejects(
    acquireManagedMicromambaBytes(mirrorRelease, undefined, {
      condaMirrorBaseUrl: "https://mirrors.example/conda-forge",
      downloadImplementation: async () => Buffer.from("changed archive"),
      extractImplementation: async () => {
        extracted = true;
        return Buffer.from("binary");
      },
    }),
    /conda package failed SHA256 verification/,
  );
  assert.equal(extracted, false);
});

test("managed micromamba conda mirror requires a credential-free HTTPS URL", () => {
  assert.throws(() => condaPackageUrl(mirrorRelease, "http://mirrors.example/conda-forge"), /must be an HTTPS URL/);
  assert.throws(() => condaPackageUrl(mirrorRelease, "https://user@mirrors.example/conda-forge"), /without credentials/);
});
