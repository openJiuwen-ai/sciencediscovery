// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { McpActionMenu } from "../src/views/settings/McpActionMenu.js";
import { McpServerDetails } from "../src/views/settings/McpServerDetails.js";
import type { CustomMcpServerDetails } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
const label = (node: ReactTestInstance): string => node.children.map(child => typeof child === "string" ? child : label(child)).join("");
const trigger = (view: ReactTestRenderer) => view.root.findAll(node => node.type === "button" && node.props["aria-haspopup"] === "menu")[0]!;
const entry = (view: ReactTestRenderer, text: string) => view.root.findAll(node => node.type === "button" && label(node) === text)[0]!;
const documentStub = { activeElement: {} as object, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });

test("an open MCP menu enters at the last or first item when focus remains on its trigger", async () => {
  const buttons = Array.from({ length: 3 }, () => ({ focus() { documentStub.activeElement = this; } }));
  const triggerNode = { focus() { documentStub.activeElement = this; } };
  const rootNode = { querySelectorAll: () => buttons };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<McpActionMenu name="Echo" busy={false} onTry={() => {}} onEdit={() => {}} onDelete={() => {}} />, {
      createNodeMock: node => node.props.className === "mcp-action-menu" ? rootNode : triggerNode,
    }); });
    await act(async () => trigger(view).props.onClick());
    const press = async (key: string) => act(async () => view.root.findByProps({ className: "mcp-action-menu" }).props.onKeyDown({ key, preventDefault() {} }));
    triggerNode.focus(); await press("ArrowUp"); assert.equal(documentStub.activeElement, buttons[2]);
    await press("ArrowDown"); assert.equal(documentStub.activeElement, buttons[0]);
    triggerNode.focus(); await press("ArrowDown"); assert.equal(documentStub.activeElement, buttons[0]);
    await press("ArrowUp"); assert.equal(documentStub.activeElement, buttons[2]);
  } finally { if (view) await act(async () => view.unmount()); }
});

test("MCP pending authorization retains detail recovery actions and blocks another start", async () => {
  const actions: string[] = [];
  const server = { id: "custom-echo", name: "Echo", sourceId: "custom-echo", description: "", transport: "http", enabled: true,
    args: [], command: "", cwd: "", env: {}, headers: {}, url: "https://provider.test/mcp", authMode: "oauth",
    authorization: { state: "authorizing" }, status: "untested", timeoutSeconds: 60, tools: [] } as CustomMcpServerDetails;
  const t = TEXT.settings.system.mcp;
  const render = (busy: boolean) => <McpServerDetails server={server} selected={false} busy={busy} status={t.authorizing}
    authorizationUrl="https://provider.test/authorize" onClose={() => {}} onEdit={() => {}} onTest={() => {}}
    onToggleEnabled={() => {}} onToggleDefault={() => {}} onTry={() => {}} tryDisabled={false} onDelete={() => {}}
    onAuthorize={() => actions.push("authorize")} onEndAuthorization={action => actions.push(action)} />;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(render(false)); });
  try {
    assert.equal(entry(view, t.authorize).props.disabled, true);
    await act(async () => entry(view, t.authorize).props.onClick());
    assert.deepEqual(actions, []);
    const link = view.root.findByType("a");
    assert.equal(link.props.href, "https://provider.test/authorize");
    assert.equal(link.props.target, "_blank"); assert.equal(link.props.rel, "noopener noreferrer");
    await act(async () => entry(view, t.cancelAuthorization).props.onClick());
    await act(async () => entry(view, t.clearAuthorization).props.onClick());
    assert.deepEqual(actions, ["cancel", "clear"]);
    await act(async () => view.update(render(true)));
    assert.equal(entry(view, t.cancelAuthorization).props.disabled, true);
    assert.equal(entry(view, t.clearAuthorization).props.disabled, true);
    assert.equal(view.root.findByType("a").props["aria-disabled"], true);
  } finally { await act(async () => view.unmount()); }
});

test("a busy MCP menu closes and cannot dispatch an action", async () => {
  const actions: string[] = [];
  const render = (busy: boolean) => <McpActionMenu name="Echo" busy={busy} onTry={() => actions.push("try")} onEdit={() => actions.push("edit")} />;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(render(false)); });
  try {
    await act(async () => trigger(view).props.onClick());
    assert.ok(entry(view, TEXT.settings.edit));
    await act(async () => view.update(render(true)));
    assert.equal(trigger(view).props.disabled, true);
    assert.equal(view.root.findAll(node => node.props.role === "menuitem").length, 0);
    await act(async () => trigger(view).props.onClick());
    assert.deepEqual(actions, []); assert.equal(trigger(view).props["aria-expanded"], false);
  } finally { await act(async () => view.unmount()); }
});
