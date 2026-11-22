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
  window: Object.assign(new EventTarget(), {
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    location: { origin: "http://127.0.0.1:5173" },
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  }),
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
  testServer?: Record<string, unknown>;
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
      if (method === "PUT" && path === `/api/mcp/servers/${SERVER_ID}`) return server();
      if (path.endsWith("/test")) return server({ tools: [{ annotations: {}, description: "Read a file", inputSchema: {}, name: "read_file", schemaHash: "h" }], ...options.testServer });
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

async function mount(client: ApiClient, onToast: React.ComponentProps<typeof McpServers>["onToast"] = () => {}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(McpServers, { client, onConfirm: () => {}, onToast }));
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
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
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
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
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

test("Edit after a create opens the record's own fields, not the creation result", async () => {
  const api = fakeClient({ servers: [server()] });
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { await flush(); });
  const name = textInputs(renderer.root)[0]!;
  await act(async () => { name.props.onChange({ target: { value: "Files" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  await act(async () => { await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /read_file/, "the creation result is on screen");
  await act(async () => { button(renderer.root, t.done).props.onClick(); });
  await act(async () => { await flush(); });

  await act(async () => { button(renderer.root, TEXT.settings.edit).props.onClick(); });
  await act(async () => { await flush(); });
  const inputs = textInputs(renderer.root);
  assert.ok(inputs.length > 0, "the edit form renders its fields");
  assert.equal(inputs[0]!.props.value, "Files", "and shows the row being edited");
  assert.equal(JSON.stringify(renderer.toJSON()).includes("read_file"), false, "the previous result is gone");
  renderer.unmount();
});

test("a row waiting on its consent page is re-read until the grant lands, then tested and unlocked", async () => {
  // The fake list answers `authorizing` until the third read, as the route does
  // once the provider callback has run.
  let reads = 0;
  const base = fakeClient();
  const api = Object.assign(Object.create(null), base, {
    request: async (path: string, init?: { body?: string; method?: string }) => {
      if (path === "/api/mcp/servers" && (init?.method ?? "GET") === "GET") {
        reads += 1;
        base.calls.push({ method: "GET", path });
        return [server({ authorization: { state: reads >= 3 ? "authorized" : "authorizing" } })];
      }
      return base.request(path, init);
    },
  }) as ApiClient & { calls: Call[] };
  const renderer = await mount(api);
  try {
    assert.equal(button(renderer.root, t.authorize).props.disabled, true, "授权 is locked while consent is pending");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_400)); });
    await act(async () => { await flush(); });
    assert.ok(reads >= 3, `the page re-read the list while authorizing (${reads} reads)`);
    assert.ok(base.calls.some((call) => call.path === `/api/mcp/servers/${SERVER_ID}/test`), "the landed grant is tested");
    assert.equal(button(renderer.root, t.authorize).props.disabled, false, "授权 is usable again once the state settles");
    assert.equal(renderer.root.findAll((node) => node.type === "button" && text(node).trim() === t.cancelAuthorization).length, 0);
    const settled = reads;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_700)); });
    assert.equal(reads, settled, "polling stops once nothing is authorizing");
  } finally {
    // The watch is a live interval: the renderer must go even when an assertion
    // above throws, or the runner never reaches an empty event loop.
    renderer.unmount();
  }
});

test("添加服务器 starts the new server switched off, as import does", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { await flush(); });
  await act(async () => { textInputs(renderer.root)[0]!.props.onChange({ target: { value: "Files" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  await act(async () => { await flush(); });
  const post = api.calls.find((call) => call.method === "POST" && call.path === "/api/mcp/servers");
  assert.equal((post!.body as { enabled: boolean }).enabled, false);
  renderer.unmount();
});

test("saving the create form without a name says so instead of doing nothing", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { await flush(); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  await act(async () => { await flush(); });
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), new RegExp(t.nameRequired));
  renderer.unmount();
});

test("授权 detaches the popup from this window, and a blocked popup still leaves a link", async () => {
  const opened: Array<{ opener: unknown }> = [];
  const win = globalThis.window as unknown as { open?: (...args: unknown[]) => unknown };
  try {
    win.open = () => {
      const popup = { close: () => {}, closed: false, location: { replace: () => {} }, opener: {} as unknown };
      opened.push(popup);
      return popup;
    };
    const api = fakeClient({ servers: [server({ authorization: { state: "required" } })] });
    const renderer = await mount(api);
    await act(async () => { button(renderer.root, t.authorize).props.onClick(); });
    await act(async () => { await flush(); });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.opener, null, "the provider page cannot navigate the settings window");
    renderer.unmount();

    win.open = () => null;
    let reads = 0;
    const blocked = fakeClient();
    const api2 = Object.assign(Object.create(null), blocked, {
      request: async (path: string, init?: { body?: string; method?: string }) => {
        if (path === "/api/mcp/servers" && (init?.method ?? "GET") === "GET") {
          reads += 1;
          return [server({ authorization: { state: reads > 1 ? "authorizing" : "required" } })];
        }
        return blocked.request(path, init);
      },
    }) as ApiClient;
    const renderer2 = await mount(api2);
    try {
      await act(async () => { button(renderer2.root, t.authorize).props.onClick(); });
      await act(async () => { await flush(); });
      const links = renderer2.root.findAll((node) => node.type === "a" && node.props.href === "https://provider.test/authorize");
      assert.equal(links.length, 1, "the minted URL is reachable from the row");
      assert.equal(links[0]!.props.rel, "noopener noreferrer");
    } finally {
      renderer2.unmount();
    }
  } finally {
    delete win.open;
  }
});

test("the import preview reads the transport the way the route does", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.importServers).props.onClick(); });
  await act(async () => { await flush(); });
  const area = renderer.root.findAll((node) => node.type === "textarea")[0]!;
  const spec = JSON.stringify({
    mcpServers: {
      aliased: { type: "streamable_http", url: "https://mcp.test/a" },
      both: { command: "node", url: "https://mcp.test/b" },
      sse: { type: "sse", url: "https://mcp.test/c" },
    },
  });
  await act(async () => { area.props.onChange({ target: { value: spec } }); });
  await act(async () => { button(renderer.root, t.importPreview).props.onClick(); });
  await act(async () => { await flush(); });
  const rows = renderer.root.findAll((node) => node.type === "li").map((node) => text(node).replace(/\s+/g, " ").trim());
  assert.ok(rows.some((row) => row.includes("aliased") && row.includes("http · https://mcp.test/a")), JSON.stringify(rows));
  assert.ok(rows.some((row) => row.includes("both") && row.includes("http · https://mcp.test/b")), "url wins over command, as the route decides");
  assert.ok(rows.some((row) => row.includes("sse") && row.includes("sse · https://mcp.test/c")), JSON.stringify(rows));
  renderer.unmount();
});

test("testing a disabled OAuth server awaiting consent does not report success", async () => {
  const authorization = { state: "required" };
  const api = fakeClient({
    servers: [server({ enabled: false, status: "disabled", authorization })],
    testServer: { enabled: false, status: "disabled", authorization, tools: [] },
  });
  const toasts: Array<{ message: string; tone?: string }> = [];
  const renderer = await mount(api, (message, tone) => { toasts.push({ message, tone }); });
  await act(async () => { button(renderer.root, t.test).props.onClick(); await flush(); });
  assert.deepEqual(toasts, [{ message: t.unauthorized, tone: "error" }]);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/test")).length, 1);
  await act(async () => renderer.unmount());
});

test("new MCP defaults are disabled HTTP with 60 seconds and cancel resets input", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  const open = async () => { await act(async () => { button(renderer.root, t.addServer).props.onClick(); }); };
  await open();
  const input = (label: string) => renderer.root.findByProps({ "aria-label": label });
  assert.equal(renderer.root.findByProps({ type: "checkbox" }).props.checked, false);
  assert.equal(renderer.root.findByProps({ "aria-label": t.transport }).props.value, "http");
  assert.equal(input(t.timeout).props.value, "60");
  await act(async () => { input(t.name).props.onChange({ target: { value: "Discard me" } }); });
  await act(async () => { button(renderer.root, TEXT.settings.cancel).props.onClick(); });
  assert.equal(renderer.root.findAllByType("form").length, 0);
  await open();
  assert.equal(input(t.name).props.value, "");
  assert.equal(input(t.timeout).props.value, "60");
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  await act(async () => renderer.unmount());
});

test("invalid native form constraints prevent a write", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { renderer.root.findByProps({ "aria-label": t.name }).props.onChange({ target: { value: "Files" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => false } }); });
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(renderer.root.findByProps({ "aria-label": t.timeout }).props.max, "600");
  await act(async () => renderer.unmount());
});

test("editing another field preserves spaced and empty legacy MCP arguments", async () => {
  const args = ["/srv/my MCP/echo.mjs", "", "--quiet"];
  const api = fakeClient({ servers: [server({ args })] });
  const renderer = await mount(api);
  await act(async () => { button(renderer.root, TEXT.settings.edit).props.onClick(); });
  assert.equal(renderer.root.findByProps({ "aria-label": t.args }).props.value, args.join("\n"));
  await act(async () => { renderer.root.findByProps({ "aria-label": t.name }).props.onChange({ target: { value: "Renamed" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  const write = api.calls.find((call) => call.method === "PUT");
  assert.deepEqual((write?.body as { args: string[] }).args, args);
  await act(async () => renderer.unmount());
});
