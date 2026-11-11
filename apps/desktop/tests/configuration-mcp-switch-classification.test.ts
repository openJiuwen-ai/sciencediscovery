// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { desktopConfigurationPresentation } from "../src/app/configuration-presentation.js";

const serverId = "custom-000000000abc";
function availability(enabled = true): ConfigurationRequestView {
  return {
    id: "cfg", sessionId: "session", projectId: "project", protocolVersion: 3, revision: 1, stateVersion: 1, schemaVersion: 1, adapterVersion: 1,
    capabilityId: "mcp.availability" as never, state: "awaiting_confirmation", reason: { code: "CONFIGURATION_REQUIRED", message: "Review" },
    scope: { kind: "global" }, fields: [
      { id: "serverId", label: "Existing custom MCP server", kind: "enum", required: true, value: serverId, choices: [{ id: serverId, label: `Owned MCP · http · ${serverId}` }] },
      { id: "enabled", label: "Available globally", kind: "boolean", required: true, value: enabled },
    ], changes: [{ field: "enabled", before: String(!enabled), after: String(enabled) }],
    // Schema classification only. The shared known-risk summary has separate
    // tests with the full production adapter copy; do not exempt arbitrary prose.
    impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "Shared MCP availability across all Sessions · http", message: "Review the saved server before enabling it." },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, previewDigest: "sha256:preview",
    activation: { mode: "next_invocation" as never, state: "not_requested" }, resumption: { state: "not_requested" },
    allowedActions: ["preview", "apply", "dismiss"], createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
  };
}
function connector(before: string[] = []): ConfigurationRequestView {
  return { ...availability(), capabilityId: "connector.enable", scope: { kind: "session", id: "session" },
    fields: [{ id: "connectorId", label: "Connector", kind: "enum", required: true, value: serverId, choices: [{ id: serverId, label: serverId }] }],
    changes: [{ field: "enabledConnectorIds", before: before.join(", "), after: [...before, serverId].join(", ") }],
    impact: { resourceLocation: "Session settings", effectiveScope: "This session only", message: "Other sessions stay unchanged. Tool calls retain their own approval policy." },
    activation: { mode: "next_run", state: "not_requested" },
  };
}
const unsupported = { unsupported: true };
test("MCP availability enables and disables inline without duplicating the bound ID", () => {
  for (const enabled of [true, false]) assert.deepEqual(desktopConfigurationPresentation(availability(enabled)), {
    fieldIds: ["enabled"], targetLabel: `Owned MCP · http · ${serverId}`,
  });
});
test("MCP availability requires global scope, exact server/boolean schema and matching changed value", () => {
  const view = availability();
  const invalid: Partial<ConfigurationRequestView>[] = [
    { scope: { kind: "session", id: "session" } }, { activation: { mode: "next_run", state: "not_requested" } }, { state: "collecting_input" }, { previewDigest: undefined },
    { fields: [view.fields[0]!] }, { fields: [...view.fields, { id: "command", label: "Command", kind: "text", required: true, value: "run" }] },
    { fields: [{ ...view.fields[0]!, value: "arxiv", choices: [{ id: "arxiv", label: "arXiv" }] } as never, view.fields[1]!] },
    { fields: [{ ...view.fields[0]!, choices: [] } as never, view.fields[1]!] },
    { fields: [view.fields[0]!, { ...view.fields[1]!, value: "true" } as never] },
    { changes: [] }, { changes: [{ field: "enabled", before: "false", after: "false" }] },
    { changes: [{ field: "enabled", after: "true" }] }, { changes: [{ field: "name", before: "old", after: "new" }] },
  ];
  for (const patch of invalid) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch }), unsupported);
});
test("availability still rejects network verification, auto-apply, unknown long risks and long targets", () => {
  const view = availability();
  for (const patch of [
    { autoApplyAt: "2026-11-09T00:00:10Z" },
    { verificationPlan: { targets: ["https://example.test"], actions: ["connect"], maxRequests: 1, mayCharge: false } },
    { impact: { ...view.impact, message: "Unknown new risk. ".repeat(20) } },
    { fields: [{ ...view.fields[0], choices: [{ id: serverId, label: "界".repeat(100) }] }, view.fields[1]] },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch } as ConfigurationRequestView), unsupported);
});
test("Session connector addition proves a single target even with long existing connector lists", () => {
  const prior = ["custom-000000000001", "custom-000000000002", "custom-000000000003"];
  for (const before of [[], prior]) assert.deepEqual(desktopConfigurationPresentation(connector(before)), {
    connectorAddition: true, targetLabel: serverId,
  });
  assert.equal(connector(prior).changes[0]!.after!.length, 82);
});
test("Session connector addition never hides replacement or unproven lists", () => {
  const view = connector(["pubmed"]);
  for (const change of [
    { field: "enabledConnectorIds", before: "pubmed", after: serverId },
    { field: "enabledConnectorIds", before: "pubmed", after: `pubmed, arxiv, ${serverId}` },
    { field: "enabledConnectorIds", before: serverId, after: `${serverId}, arxiv` },
    { field: "enabledConnectorIds", before: "12 connectors: pubmed …", after: "13 connectors: pubmed …" },
    { field: "enabledConnectorIds", before: "pubmed, pubmed", after: `pubmed, pubmed, ${serverId}` },
    { field: "enabledConnectorIds", after: serverId }, { field: "enabled", before: "false", after: "true" },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, changes: [change] }), unsupported);
});
const ten = Array.from({ length: 10 }, (_, index) => `custom-00000000000${index}`);
const summarized = (count: number, listed: string[] = ten) => `${count} connectors: ${listed.join(", ")} …`;
test("a summarized connector selection still proves its single addition", async () => {
  const { readFile } = await import("node:fs/promises");
  // The API integration test produces and verifies this view through a real
  // proposal: eleven enabled connectors plus the requested UniProt connector,
  // so both sides of the diff exceed the adapter's ten-ID detail limit.
  const fixtures = JSON.parse(await readFile(new URL("../../../test/fixtures/configuration-connector-summarized-addition.json", import.meta.url), "utf8")) as Array<{ kind: string; view: ConfigurationRequestView }>;
  assert.deepEqual(fixtures.map(fixture => fixture.kind), ["summarizedAddition"]);
  assert.deepEqual(desktopConfigurationPresentation(fixtures[0]!.view), { connectorAddition: true, targetLabel: "uniprot" });
  // Only the result is summarized when the baseline holds exactly ten IDs.
  const after = [...ten, serverId].sort();
  assert.deepEqual(desktopConfigurationPresentation({ ...connector(ten), changes: [{ field: "enabledConnectorIds",
    before: ten.join(", "), after: summarized(11, after.slice(0, 10)) }] }), { connectorAddition: true, targetLabel: serverId });
});
test("a summarized connector selection proves nothing from a list prefix", () => {
  const view = connector(["pubmed"]);
  for (const change of [
    { field: "enabledConnectorIds", before: summarized(11), after: summarized(13) },
    { field: "enabledConnectorIds", before: summarized(13), after: summarized(12) },
    { field: "enabledConnectorIds", before: summarized(11), after: summarized(11) },
    { field: "enabledConnectorIds", before: summarized(11, [serverId, ...ten.slice(1)]), after: summarized(12, [serverId, ...ten.slice(1)]) },
    // The adapter appends the requested connector, so a summarized result that
    // drops a visible baseline ID is a swap, not an addition, even at count +1.
    { field: "enabledConnectorIds", before: ten.join(", "), after: summarized(11, [...ten.slice(1), "custom-0000000000ff"]) },
    { field: "enabledConnectorIds", before: summarized(11), after: summarized(12, [...ten.slice(1), "custom-0000000000ff"]) },
    { field: "enabledConnectorIds", before: summarized(11).replace(" …", ""), after: summarized(12) },
    { field: "enabledConnectorIds", before: "11 connectors: pubmed …", after: "12 connectors: pubmed …" },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, changes: [change] }), unsupported);
});
test("Session connector addition requires exact current-session target binding", () => {
  const view = connector();
  for (const patch of [
    { scope: { kind: "global" } }, { scope: { kind: "session", id: "another-session" } },
    { fields: [{ ...view.fields[0], choices: [] }] },
    { fields: [...view.fields, { id: "restoreInheritance", kind: "boolean", label: "Restore", value: true }] },
    { state: "collecting_input" }, { previewDigest: undefined },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch } as ConfigurationRequestView), unsupported);
});
test("bound labels deduplicate only an exact trailing ID, not a name containing it", () => {
  const view = availability();
  const fields = view.fields.map(field => field.id === "serverId" ? { ...field, choices: [{ id: serverId, label: `Server (${serverId})` }] } : field);
  assert.equal(desktopConfigurationPresentation({ ...view, fields } as ConfigurationRequestView).targetLabel, `Server (${serverId})`);
  const partial = view.fields.map(field => field.id === "serverId" ? { ...field, choices: [{ id: serverId, label: `Prefix ${serverId} suffix` }] } : field);
  assert.equal(desktopConfigurationPresentation({ ...view, fields: partial } as ConfigurationRequestView).targetLabel, `Prefix ${serverId} suffix (${serverId})`);
});
