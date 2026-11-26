// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { McpRowMenu, type McpRowAction } from "../src/views/settings/McpRowMenu.js";
import { SettingsRowMenu } from "../src/views/settings/SettingsRowMenu.js";
import { TEXT } from "../src/text.js";

const label = (node: ReactTestInstance): string => node.children.map(child => typeof child === "string" ? child : label(child)).join("");
const trigger = (view: ReactTestRenderer) => view.root.findAll(node => node.type === "button" && node.props["aria-haspopup"] === "menu")[0]!;
const entry = (view: ReactTestRenderer, text: string) => view.root.findAll(node => node.props.role === "menuitem" && label(node) === text)[0]!;

test("an open row menu enters at the last or first item when focus remains on its trigger", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const documentStub = { activeElement: {} as object, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
  const buttons = Array.from({ length: 3 }, () => ({ focus() { documentStub.activeElement = this; } }));
  const triggerNode = { focus() { documentStub.activeElement = this; } };
  const rootNode = { querySelectorAll: () => buttons, closest: () => null };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<SettingsRowMenu label="Actions" items={["Tools", "Edit", "Delete"].map(key => ({ key, label: key, icon: null }))} />, {
      createNodeMock: node => node.props.className === "skill-row-menu" ? rootNode : triggerNode,
    }); });
    await act(async () => { trigger(view).props.onClick(); });
    assert.equal(trigger(view).props["aria-expanded"], true);
    const press = async (key: string) => act(async () => {
      view.root.findByProps({ className: "skill-row-menu" }).props.onKeyDown({ key, preventDefault() {} });
    });
    triggerNode.focus();
    await press("ArrowUp");
    assert.equal(documentStub.activeElement, buttons[2], "ArrowUp enters the last item from the trigger");
    await press("ArrowDown");
    assert.equal(documentStub.activeElement, buttons[0], "ArrowDown wraps from the last item");
    triggerNode.focus();
    await press("ArrowDown");
    assert.equal(documentStub.activeElement, buttons[0], "ArrowDown enters the first item from the trigger");
    await press("ArrowUp");
    assert.equal(documentStub.activeElement, buttons[2], "ArrowUp wraps from the first item");
  } finally {
    if (view) await act(async () => view.unmount());
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("MCP pending authorization retains recovery actions and blocks another start", async () => {
  const actions: McpRowAction[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<McpRowMenu disabled={false} name="Echo"
    authorization={{ state: "authorizing" }} authorizationUrl="https://provider.test/authorize"
    onAction={action => actions.push(action)} />); });
  try {
    await act(async () => { trigger(view).props.onClick(); });
    const t = TEXT.settings.system.mcp;
    assert.equal(entry(view, t.authorize).props.disabled, true);
    await act(async () => { entry(view, t.authorize).props.onClick(); });
    assert.deepEqual(actions, [], "a pending grant cannot start another authorization");
    const link = entry(view, t.openAuthorization);
    assert.equal(link.type, "a");
    assert.equal(link.props.href, "https://provider.test/authorize");
    assert.equal(link.props.rel, "noopener noreferrer");
    await act(async () => { entry(view, t.cancelAuthorization).props.onClick(); });
    assert.deepEqual(actions, ["cancelAuthorization"]);
    assert.equal(trigger(view).props["aria-expanded"], false);
    await act(async () => { trigger(view).props.onClick(); });
    await act(async () => { entry(view, t.clearAuthorization).props.onClick(); });
    assert.deepEqual(actions, ["cancelAuthorization", "clearAuthorization"]);
    await act(async () => { trigger(view).props.onClick(); });
    await act(async () => { entry(view, TEXT.menu.delete).props.onClick(); });
    assert.deepEqual(actions, ["cancelAuthorization", "clearAuthorization", "delete"]);
  } finally { await act(async () => view.unmount()); }
});

test("a busy MCP row closes its menu and cannot dispatch an action", async () => {
  const actions: McpRowAction[] = [];
  const render = (disabled: boolean) => <McpRowMenu disabled={disabled} name="Echo" onAction={action => actions.push(action)} />;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(render(false)); });
  try {
    await act(async () => { trigger(view).props.onClick(); });
    assert.ok(entry(view, TEXT.settings.system.mcp.test));
    await act(async () => { view.update(render(true)); });
    assert.equal(trigger(view).props.disabled, true);
    assert.equal(view.root.findAll(node => node.props.role === "menuitem").length, 0);
    await act(async () => { trigger(view).props.onClick(); });
    assert.deepEqual(actions, []);
    assert.equal(trigger(view).props["aria-expanded"], false);
  } finally { await act(async () => view.unmount()); }
});
