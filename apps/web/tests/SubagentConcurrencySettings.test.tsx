import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SYSTEM_QUOTA_SETTINGS, type SystemQuotaSettings } from "@sciencediscovery/schema";
import { QuotaSettingsEditor } from "../src/RuntimeControls.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("subagent limit edits only the quota draft, retaining other settings", async () => {
  const original = { ...DEFAULT_SYSTEM_QUOTA_SETTINGS };
  const drafts: SystemQuotaSettings[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(QuotaSettingsEditor, { settings: original, onChange: (draft) => drafts.push(draft) })); });
  try {
    const input = renderer.root.findByProps({ "aria-label": "Maximum concurrent subagents" });
    assert.equal(input.props.value, 10);
    await act(async () => input.props.onChange({ target: { value: "1" } }));
    assert.deepEqual(drafts, [{ ...original, maxConcurrentSubagents: 1 }]);
    assert.equal(original.maxConcurrentSubagents, undefined);
    for (const value of ["0", "11", "1.5", ""]) await act(async () => input.props.onChange({ target: { value } }));
    assert.equal(drafts.length, 1);
    await act(async () => renderer.update(createElement(QuotaSettingsEditor, { settings: drafts[0]!, onChange: (draft) => drafts.push(draft) })));
    assert.equal(renderer.root.findByProps({ "aria-label": "Maximum concurrent subagents" }).props.value, 1);
  } finally { await act(async () => renderer.unmount()); }
});
