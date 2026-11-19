// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import React from "react";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { manifest } from "./manifest.js";
import { connectorName, groupConnectors } from "./connector-picker.js";
import { McpSettingsSection } from "./web.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("MCP manifest declares the runtime and web entries with scoped settings", () => {
  assert.equal(manifest.id, "mcp");
  assert.equal(manifest.entries!.runtime, "./plugin");
  assert.equal(manifest.entries!.web, "./web");
  assert.deepEqual(manifest.configuration?.scopes, ["global", "project", "session"]);
  assert.ok(manifest.capabilities!.includes("tools"));
});

test("connector grouping keeps built-ins, web and custom servers separate", () => {
  assert.equal(connectorName("europe-pmc"), "Europe PMC");
  assert.equal(connectorName("custom-lab" as never), "custom-lab");
  const groups = groupConnectors([
    { id: "pubmed", publisher: "fixture" },
    { id: "web", publisher: "fixture" },
    { id: "custom-lab", publisher: "fixture" },
  ] as never);
  assert.deepEqual(groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
    ["connectors.groupBuiltin", ["pubmed"]],
    ["connectors.groupWeb", ["web"]],
    ["connectors.groupCustom", ["custom-lab"]],
  ]);
});


test("MCP settings section builds the connector fieldset and source inheritance control", () => {
  const element = McpSettingsSection({
    details: { effective: { enabledConnectorIds: ["pubmed"], enabledSkillIds: [], enabledSkillLibraries: [], semanticReviewEnabled: false, skillSelectionMode: "all" }, overrides: {}, sources: {} } as never,
    draft: { enabledConnectorIds: ["web"] },
    setDraft: () => {},
    connectors: [{ id: "pubmed", publisher: "fixture" }, { id: "web", publisher: "fixture" }] as never,
    allowInheritance: true,
    disabled: false,
    t: (key: string) => key,
    renderSource: (field) => React.createElement("span", { "data-source": field }, "source"),
  });
  const children = (element as React.ReactElement<any>).props.children as any[];
  const fieldset = children[1] as any;
  assert.equal(fieldset.type, "fieldset");
  assert.equal(fieldset.props.className, "settings-array");
  const fieldsetChildren = fieldset.props.children as any[];
  assert.equal(fieldsetChildren[0].type, "legend");
  assert.equal(fieldsetChildren[1].type, "select");
  assert.equal(fieldsetChildren[3].props["data-source"], "enabledConnectorIds");
});
