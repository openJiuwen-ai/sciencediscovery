import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { manifest } from "./manifest.js";
import { jsonViewer } from "./web.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("artifact JSON manifest exposes a stable viewer contract", () => {
  assert.equal(manifest.id, "artifact-json");
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.capabilities, ["artifact.viewer"]);
  assert.deepEqual(manifest.permissions, ["artifact.read"]);
  assert.equal(jsonViewer.id, "artifact.json");
  assert.equal(jsonViewer.pluginId, "artifact-json");
});

test("artifact JSON viewer matches only JSON artifacts and preserves invalid/truncated state", () => {
  const valid = { kind: "json" as const, parsed: true, source: "{}", truncated: false, labels: { invalidJson: "invalid", truncated: "truncated" } };
  const invalid = { ...valid, parsed: false, truncated: true };
  assert.equal(jsonViewer.matches(valid), true);
  assert.equal(jsonViewer.matches({ kind: "text" } as never), false);
  const element = jsonViewer.render(invalid);
  assert.equal(typeof element, "object");
  assert.equal((element as { props?: { parsed?: boolean; truncated?: boolean } }).props?.parsed, false);
  assert.equal((element as { props?: { parsed?: boolean; truncated?: boolean } }).props?.truncated, true);
});
