// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import { McpServers } from "../src/views/settings/system/McpServers.js";
import { TEXT } from "../src/text.js";

// The settings form registers an Escape listener on the document; this renderer
// has none of its own.
const listeners = new Map<string, Set<() => void>>();
Object.assign(globalThis, {
  document: {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  },
  window: Object.assign(new EventTarget(), { location: { origin: "http://127.0.0.1:5173" } }),
});

const t = TEXT.settings.system.mcp;
const SERVER_ID = "custom-0123456789ab";

function server(patch: Record<string, unknown> = {}) {
  return {
    args: [], authMode: "headers", authorization: undefined, checkedAt: undefined, command: "", cwd: "",
    description: "", durationMs: undefined, enabled: true, env: {}, error: undefined, headers: {},
    id: SERVER_ID, name: "Files", sourceId: SERVER_ID, status: "ready", timeoutSeconds: 30, tools: [],
    transport: "stdio", url: "", ...patch,
  };
}

type Call = { body?: unknown; method: string; path: string };

function fakeClient(options: {
  createError?: string;
  importError?: string;
  servers?: unknown[];
} = {}) {
  const calls: Call[] = [];
  let imported = 0;
  const api = {
    calls,
    request: async (path: string, init?: { body?: string; method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, method, path });
      if (path === "/api/mcp/servers" && method === "GET") return options.servers ?? [];
      if (path === "/api/mcp/sources") return [];
      if (path === "/api/settings") return { effective: { enabledConnectorIds: [] }, overrides: {} };
      if (path === "/api/mcp/servers" && method === "POST") {
        if (options.createError !== undefined) throw new Error(options.createError);
        return server({ name: "Files" });
      }
      if (path.endsWith("/test")) return server({ tools: [{ annotations: {}, description: "Read a file", inputSchema: {}, name: "read_file", schemaHash: "h" }] });
      if (path === "/api/mcp/servers/import") {
        imported += 1;
        if (options.importError !== undefined && imported > 1) throw new Error(options.importError);
        return [];
      }
      if (path.endsWith("/oauth/start")) return { authorizationUrl: "https://provider.test/authorize", expiresAt: "2026-11-20T00:00:00Z" };
      if (path.endsWith("/oauth/cancel") || path.endsWith("/oauth/clear")) return { ok: true };
      throw new Error(`unmocked ${method} ${path}`);
    },
  };
  return api as unknown as ApiClient & { calls: Call[] };
}

async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

async function mount(client: ApiClient): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(McpServers, { client, onConfirm: () => {}, onToast: () => {} }));
  });
  await act(async () => { await flush(); });
  return renderer;
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map((child) => text(child)).join("");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && text(node).trim() === label);
  assert.ok(found.length > 0, `no button labelled ${label}`);
  return found[0]!;
}

function textInputs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "input" && node.props.type !== "checkbox" && node.props.type !== "password");
}

test("添加服务器 opens an empty form and posts without an id, then names the tools it found", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { await flush(); });

  const name = textInputs(renderer.root)[0]!;
  await act(async () => { name.props.onChange({ target: { value: "Files" } }); });
  await act(async () => { button(renderer.root, TEXT.settings.system.save).props.onClick(); });
  await act(async () => { await flush(); });

  const posts = api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers");
  assert.equal(posts.length, 1, "one create, and it carries no id");
  assert.equal((posts[0]!.body as { name: string }).name, "Files");
  const tests = api.calls.filter((call) => call.path.endsWith("/test"));
  assert.deepEqual(tests.map((call) => call.path), [`/api/mcp/servers/${SERVER_ID}/test`]);
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /read_file/, "the first test names the tool it found");
  renderer.unmount();
});

test("a refused create keeps the form open with the reason", async () => {
  const api = fakeClient({ createError: "A server named Files already exists" });
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { await flush(); });
  const name = textInputs(renderer.root)[0]!;
  await act(async () => { name.props.onChange({ target: { value: "Files" } }); });
  await act(async () => { button(renderer.root, TEXT.settings.system.save).props.onClick(); });
  await act(async () => { await flush(); });

  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /already exists/);
  assert.ok(textInputs(renderer.root).length > 0, "the form is still open");
  renderer.unmount();
});

test("import writes one server per request and reports each outcome", async () => {
  const api = fakeClient({ importError: "A server named taken already exists" });
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.importServers).props.onClick(); });
  await act(async () => { await flush(); });
  const area = renderer.root.findAll((node) => node.type === "textarea")[0]!;
  const spec = JSON.stringify({ mcpServers: { fresh: { command: "node", args: ["s.js"] }, taken: { url: "https://mcp.test" } } });
  await act(async () => { area.props.onChange({ target: { value: spec } }); });
  await act(async () => { button(renderer.root, t.importPreview).props.onClick(); });
  await act(async () => { await flush(); });
  const preview = JSON.stringify(renderer.toJSON());
  assert.match(preview, /fresh/);
  assert.match(preview, /taken/);

  await act(async () => { button(renderer.root, t.importRun).props.onClick(); });
  await act(async () => { await flush(); });

  const imports = api.calls.filter((call) => call.path === "/api/mcp/servers/import");
  assert.equal(imports.length, 2, "one request per server, so each reports on its own");
  assert.deepEqual(Object.keys((imports[0]!.body as { mcpServers: object }).mcpServers), ["fresh"]);
  assert.deepEqual(Object.keys((imports[1]!.body as { mcpServers: object }).mcpServers), ["taken"]);
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, new RegExp(t.importAdded));
  assert.match(markup, /already exists/, "the refused half keeps its own reason");
  renderer.unmount();
});

test("a server that needs authorization says so, and 授权 asks the route for the URL", async () => {
  const api = fakeClient({ servers: [server({ authorization: { state: "required" } })] });
  const renderer = await mount(api);
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, new RegExp(t.unauthorized));

  await act(async () => { button(renderer.root, t.authorize).props.onClick(); });
  await act(async () => { await flush(); });
  const start = api.calls.find((call) => call.path.endsWith("/oauth/start"));
  assert.ok(start, "the authorize control calls the route");
  assert.equal((start!.body as { redirectUrl: string }).redirectUrl, "http://127.0.0.1:5173/api/mcp/oauth/callback");
  renderer.unmount();
});

test("a stored env secret is never rendered back", async () => {
  const api = fakeClient({ servers: [server({ env: { TOKEN: null } })] });
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, TEXT.settings.edit).props.onClick(); });
  await act(async () => { await flush(); });
  const secret = renderer.root.findAll((node) => node.type === "input" && node.props.type === "password")[0]!;
  assert.equal(secret.props.value, "", "the stored value is not in the form");
  assert.equal(secret.props.placeholder, t.secretSaved);
  assert.equal(JSON.stringify(renderer.toJSON()).includes("TOKEN=null"), false);
  renderer.unmount();
});
