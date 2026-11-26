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
  updateError?: string; createError?: string; importError?: string; importWait?: Promise<void>;
  servers?: unknown[]; testServer?: Record<string, unknown>;
} = {}) {
  const calls: Call[] = [];
  let records = (options.servers ?? []) as Array<Record<string, unknown>>;
  let creates = 0;
  const redact = (input: Record<string, unknown>) => ({ ...input,
    env: Object.fromEntries(Object.keys(input.env as object ?? {}).map((key) => [key, null])),
    headers: Object.fromEntries(Object.keys(input.headers as object ?? {}).map((key) => [key, null])),
  });
  const api = { calls, request: async (path: string, init?: { body?: string; method?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ body, method, path });
    if (path === "/api/mcp/servers" && method === "GET") return records;
    if (path === "/api/mcp/sources") return [];
    if (path === "/api/settings") return { effective: { enabledConnectorIds: [] }, overrides: {} };
    if (path === "/api/mcp/servers" && method === "POST") {
      creates += 1; await options.importWait;
      if (options.createError) throw new Error(options.createError);
      if (options.importError && creates > 1) throw new Error(options.importError);
      const id = records.length ? SERVER_ID + "-" + creates : SERVER_ID;
      const saved = server(redact({ ...body, id, sourceId: id, status: body.enabled ? "untested" : "disabled" }));
      records = [...records, saved]; return saved;
    }
    if (method === "PUT" && path === "/api/mcp/servers/" + SERVER_ID) {
      if (options.updateError) throw new Error(options.updateError);
      const saved = server(redact({ ...records.find((item) => item.id === SERVER_ID), ...body }));
      records = records.map((item) => item.id === SERVER_ID ? saved : item); return saved;
    }
    if (path.endsWith("/test")) {
      const id = path.split("/").at(-2);
      const checked = server({ ...records.find((item) => item.id === id), error: undefined,
        tools: [{ annotations: {}, description: "Read a file", inputSchema: {}, name: "read_file", schemaHash: "h" }], ...options.testServer });
      records = records.map((item) => item.id === id ? checked : item); return checked;
    }
    if (path.endsWith("/oauth/start")) return { authorizationUrl: "https://provider.test/authorize", expiresAt: "2026-11-20T00:00:00Z" };
    if (path.endsWith("/oauth/cancel") || path.endsWith("/oauth/clear")) return { ok: true };
    throw new Error("unmocked " + method + " " + path);
  } };
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
  return typeof node === "string" ? node : node.props["aria-hidden"] ? "" : node.children.map((child) => text(child)).join("");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && text(node).trim() === label);
  assert.ok(found.length > 0, `no button labelled ${label}`);
  return found[0]!;
}

function textInputs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "input" && !["search", "checkbox", "password", "file"].includes(node.props.type));
}

test("MCP-UI3-02 card enablement persists into editing without losing secrets or legacy arguments", async () => {
  const api = fakeClient({ servers: [server({ enabled: false, env: { TOKEN: null }, args: ["echo.mjs", "", "  exact  "] })] });
  const renderer = await mount(api);
  try {
    const toggle = () => renderer.root.findAll((node) => node.type === "button" && node.props.role === "switch"
      && node.props["aria-label"] === `Files · ${t.enableService}`)[0]!;
    assert.equal(toggle().props["aria-checked"], false);
    await act(async () => { toggle().props.onClick(); await flush(); });
    assert.equal(toggle().props["aria-checked"], true);
    const saved = api.calls.find((call) => call.method === "PUT" && call.path === `/api/mcp/servers/${SERVER_ID}`);
    assert.deepEqual((saved?.body as { args: string[] }).args, ["echo.mjs", "", "  exact  "]);
    assert.deepEqual((saved?.body as { env: object }).env, { TOKEN: null });
    assert.equal(api.calls.some((call) => call.method === "PUT" && call.path === "/api/settings"), false);
    await openEdit(renderer);
    const enabled = renderer.root.findAll((node) => node.type === "button" && node.props.role === "switch" && node.props["aria-label"] === t.enableService)[0]!;
    assert.equal(enabled.props["aria-checked"], true);
    await act(async () => enabled.props.onClick());
    await submitForm(renderer);
    assert.equal(toggle().props["aria-checked"], false);
  } finally { await act(async () => renderer.unmount()); }
});

async function openDetails(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByProps({ "aria-label": t.openDetails("Files") }).props.onClick());
}
async function openEdit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByProps({ "aria-label": t.more("Files") }).props.onClick());
  await act(async () => button(renderer.root, TEXT.settings.edit).props.onClick());
}

async function openManual(renderer: ReactTestRenderer) {
  await act(async () => button(renderer.root, t.addServer).props.onClick());
  await act(async () => button(renderer.root, t.manualEntry).props.onClick());
}
async function openImport(renderer: ReactTestRenderer) {
  await act(async () => button(renderer.root, t.addServer).props.onClick());
  await act(async () => button(renderer.root, t.importJsonEntry).props.onClick());
}
async function submitForm(renderer: ReactTestRenderer) {
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); await flush(); });
}

async function uploadJson(renderer: ReactTestRenderer, file: Pick<File, "name" | "size" | "text">) {
  if (renderer.root.findAllByProps({ type: "file" }).length === 0) await openImport(renderer);
  const target = { files: [file], value: file.name };
  await act(async () => {
    renderer.root.findByProps({ type: "file" }).props.onChange({ currentTarget: target });
    await flush();
  });
  assert.equal(target.value, "", "the same file can be selected again");
}

test("添加服务器 opens an empty form and posts without an id, then names the tools it found", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  await openManual(renderer);
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
  assert.equal(renderer.root.findAllByType("form").length, 0, "one confirmation ends creation");
  await openDetails(renderer);
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /read_file/, "the saved details name the discovered tool");
  renderer.unmount();
});

test("a refused create keeps the form open with the reason", async () => {
  const api = fakeClient({ createError: "A server named Files already exists" });
  const renderer = await mount(api);
  await openManual(renderer);
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

test("retrying a saved card's failed check never creates it twice", async () => {
  const response: Record<string, unknown> = { error: "connection refused", tools: [] };
  const api = fakeClient({ testServer: response });
  const messages: string[] = [];
  const renderer = await mount(api, (message) => messages.push(message));
  try {
    await openManual(renderer);
    await act(async () => textInputs(renderer.root)[0]!.props.onChange({ target: { value: "Files" } }));
    await submitForm(renderer);
    assert.equal(renderer.root.findAllByType("form").length, 0);
    assert.ok(messages.some((message) => message.includes("connection refused")));
    delete response.error; delete response.tools;
    await act(async () => { button(renderer.root, t.test).props.onClick(); await flush(); });
    assert.equal(api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers").length, 1);
    assert.equal(api.calls.filter((call) => call.path.endsWith("/test")).length, 2);
    await openDetails(renderer);
    assert.match(JSON.stringify(renderer.toJSON()), /read_file/);
  } finally { await act(async () => renderer.unmount()); }
});

test("creation feedback distinguishes saved OAuth configuration from a successful check", async () => {
  const api = fakeClient({ testServer: { enabled: false, status: "disabled", authorization: { state: "required" }, tools: [] } });
  const messages: Array<{ message: string; tone?: string }> = [];
  const renderer = await mount(api, (message, tone) => messages.push({ message, tone }));
  try {
    await openManual(renderer);
    await act(async () => textInputs(renderer.root)[0]!.props.onChange({ target: { value: "Files" } }));
    await submitForm(renderer);
    assert.deepEqual(messages, [{ message: t.savedCheckFailed(t.unauthorized), tone: "error" }]);
    assert.equal(renderer.root.findAllByType("form").length, 0);
  } finally { await act(async () => renderer.unmount()); }
});

test("JSON fills editable batch drafts and retries only the entry that failed", async () => {
  const options = { importError: "A server named taken already exists" };
  const api = fakeClient(options);
  const renderer = await mount(api);
  try {
    await openImport(renderer);
    await act(async () => renderer.root.findByProps({ "aria-label": t.importJson }).props.onChange({ target: { value: JSON.stringify({ mcpServers: { fresh: { command: "node" }, taken: { url: "https://mcp.test" } } }) } }));
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
    await act(async () => renderer.root.findByProps({ "aria-label": t.name }).props.onChange({ target: { value: "Fresh renamed" } }));
    await submitForm(renderer);
    let posts = api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers");
    assert.deepEqual(posts.map((call) => (call.body as { name: string }).name), ["Fresh renamed", "taken"]);
    assert.match(JSON.stringify(renderer.toJSON()), /already exists/);
    assert.equal(renderer.root.findByProps({ "aria-label": t.importJson }).props.disabled, true);
    options.importError = "";
    await submitForm(renderer);
    posts = api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers");
    assert.deepEqual(posts.map((call) => (call.body as { name: string }).name), ["Fresh renamed", "taken", "taken"]);
    assert.equal(renderer.root.findAllByType("form").length, 0);
    assert.equal(api.calls.filter((call) => call.path.includes("/import")).length, 0, "one creation path for both sources");
  } finally { await act(async () => renderer.unmount()); }
});

test("a server that needs authorization says so, and 授权 asks the route for the URL", async () => {
  const api = fakeClient({ servers: [server({ authorization: { state: "required" } })] });
  const renderer = await mount(api);
  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, new RegExp(t.unauthorized));

  await openDetails(renderer);
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
  await openEdit(renderer);
  await act(async () => { await flush(); });
  const secret = renderer.root.findAll((node) => node.type === "input" && node.props.type === "password")[0]!;
  assert.equal(secret.props.value, "", "the stored value is not in the form");
  assert.equal(secret.props.placeholder, t.secretSaved);
  assert.equal(JSON.stringify(renderer.toJSON()).includes("TOKEN=null"), false);
  renderer.unmount();
});

test("Edit after creation opens the selected saved record", async () => {
  const api = fakeClient({ servers: [server()] });
  const renderer = await mount(api);
  await openManual(renderer);
  await act(async () => textInputs(renderer.root)[0]!.props.onChange({ target: { value: "New Files" } }));
  await submitForm(renderer);
  assert.equal(renderer.root.findAllByType("form").length, 0);
  await openEdit(renderer);
  assert.equal(textInputs(renderer.root)[0]!.props.value, "Files");
  assert.equal(renderer.root.findByProps({ "aria-label": t.transport }).props.value, "stdio");
  await act(async () => renderer.unmount());
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
    await openDetails(renderer);
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
  await openManual(renderer);
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
  await openManual(renderer);
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
    await openDetails(renderer);
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
      await openDetails(renderer2);
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

test("JSON drafts resolve protocol aliases and keep each editable configuration", async () => {
  const renderer = await mount(fakeClient());
  await openImport(renderer);
  await act(async () => renderer.root.findByProps({ "aria-label": t.importJson }).props.onChange({ target: { value: JSON.stringify({ mcpServers: {
    aliased: { type: "streamable_http", url: "https://mcp.test/a" }, both: { command: "node", url: "https://mcp.test/b" }, sse: { type: "sse", url: "https://mcp.test/c" },
  } }) } }));
  assert.equal(renderer.root.findByProps({ "aria-label": t.transport }).props.value, "http");
  for (const [index, transport, url] of [[1, "http", "https://mcp.test/b"], [2, "sse", "https://mcp.test/c"]]) {
    await act(async () => renderer.root.findByProps({ "aria-label": t.chooseConfiguration }).props.onChange({ target: { value: String(index) } }));
    assert.equal(renderer.root.findByProps({ "aria-label": t.transport }).props.value, transport);
    assert.equal(renderer.root.findByProps({ "aria-label": t.url }).props.value, url);
  }
  await act(async () => renderer.unmount());
});

test("a file fills the same form, preserves exact arguments and saves only after confirmation", async () => {
  const api = fakeClient(); const renderer = await mount(api);
  const config = { mcpServers: { Echo: { command: "node", args: ["/srv/my MCP/echo.mjs", ""], env: { LABEL: "a b" } }, Search: { type: "sse", url: "https://mcp.test/sse", headers: { "X-Test": "fixture" } } } };
  const json = JSON.stringify(config);
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => "\uFEFF" + json });
  assert.equal(renderer.root.findByProps({ "aria-label": t.importJson }).props.value, json);
  assert.equal(renderer.root.findByProps({ "aria-label": t.args }).props.value, "/srv/my MCP/echo.mjs\n");
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  await act(async () => button(renderer.root, TEXT.settings.cancel).props.onClick());
  await openImport(renderer);
  assert.equal(renderer.root.findByProps({ "aria-label": t.importJson }).props.value, "");
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => json });
  await submitForm(renderer);
  const posts = api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers");
  assert.equal(posts.length, 2);
  assert.deepEqual((posts[0]!.body as { args: string[] }).args, config.mcpServers.Echo.args);
  assert.deepEqual((posts[0]!.body as { env: unknown }).env, { LABEL: "a b" });
  assert.equal((posts[1]!.body as { transport: string }).transport, "sse");
  assert.deepEqual((posts[1]!.body as { headers: unknown }).headers, { "X-Test": "fixture" });
  assert.equal(renderer.root.findAllByType("form").length, 0);
  await act(async () => renderer.unmount());
});

test("invalid, oversized and unreadable JSON files report errors without importing", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  let oversizedRead = false;
  const files = [
    { name: "bad.json", size: 1, text: async () => "{", error: t.importInvalidJson },
    { name: "empty.json", size: 2, text: async () => "{}", error: t.importNoServers },
    { name: "too-many.json", size: 1000, text: async () => JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`server-${index}`, { command: "node" }])) }), error: t.importTooMany },
    { name: "large.json", size: 1_500_001, text: async () => { oversizedRead = true; return "{}"; }, error: t.importFileTooLarge },
    { name: "unreadable.json", size: 10, text: async () => { throw new Error("unreadable"); }, error: t.importFileReadFailed },
  ];
  for (const file of files) {
    await uploadJson(renderer, file);
    assert.equal(text(renderer.root.findByProps({ role: "alert" })), file.error);
    assert.equal(button(renderer.root, t.confirmAdd(1)).props.disabled, true);
    await act(async () => { button(renderer.root, TEXT.settings.cancel).props.onClick(); });
  }
  assert.equal(oversizedRead, false);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  await act(async () => renderer.unmount());
});

test("the common create drawer cannot be dismissed or submitted twice while saving JSON", async () => {
  let finish!: () => void; const importWait = new Promise<void>((resolve) => { finish = resolve; });
  const api = fakeClient({ importWait }); const renderer = await mount(api);
  const json = JSON.stringify({ mcpServers: { Echo: { command: "node" } } });
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => json });
  await submitForm(renderer);
  assert.equal(button(renderer.root, TEXT.settings.cancel).props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": TEXT.settings.close }).props.disabled, true);
  await submitForm(renderer);
  assert.equal(api.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers").length, 1);
  await act(async () => { finish(); await flush(); });
  assert.equal(renderer.root.findAllByType("form").length, 0);
  await act(async () => renderer.unmount());
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
  const open = async () => { await openManual(renderer); };
  await open();
  const input = (label: string) => renderer.root.findByProps({ "aria-label": label });
  assert.equal(renderer.root.findAll((node) => node.type === "button" && node.props.role === "switch" && node.props["aria-label"] === t.enableService)[0]?.props["aria-checked"], false);
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
  await openManual(renderer);
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
  await openEdit(renderer);
  assert.equal(renderer.root.findByProps({ "aria-label": t.args }).props.value, args.join("\n"));
  await act(async () => { renderer.root.findByProps({ "aria-label": t.name }).props.onChange({ target: { value: "Renamed" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  const write = api.calls.find((call) => call.method === "PUT");
  assert.deepEqual((write?.body as { args: string[] }).args, args);
  await act(async () => renderer.unmount());
});

test("list enable writes preserve exact arguments and stored secrets without selecting session defaults", async () => {
  const args = ["", "argument with spaces", "embedded\nnewline"];
  const api = fakeClient({ servers: [server({ enabled: false, status: "disabled", command: "node", args, env: { TOKEN: null } })] });
  const renderer = await mount(api);
  const label = `Files · ${t.enableService}`;
  assert.equal(renderer.root.findByProps({ "aria-label": label }).props["aria-checked"], false);
  await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onClick(); await flush(); });
  await act(async () => { await flush(); });
  assert.equal(renderer.root.findByProps({ "aria-label": label }).props["aria-checked"], true);
  const write = api.calls.find(call => call.method === "PUT" && call.path === `/api/mcp/servers/${SERVER_ID}`);
  assert.deepEqual((write?.body as { args: string[] }).args, args);
  assert.deepEqual((write?.body as { env: unknown }).env, { TOKEN: null });
  assert.equal(api.calls.some(call => call.method === "PUT" && call.path === "/api/settings"), false);
  await openEdit(renderer);
  const toggle = renderer.root.findAll(node => node.type === "button" && node.props.role === "switch" && node.props["aria-label"] === t.enableService)[0]!;
  assert.equal(toggle.props["aria-checked"], true);
  renderer.unmount();
});

test("list service switches retain OAuth configuration and the stored client-secret sentinel", async () => {
  const oauth = { clientId: "existing-client", clientMetadataUrl: "https://provider.test/client.json", scope: "tools:read", clientSecret: null };
  const api = fakeClient({ servers: [server({ enabled: false, status: "disabled", transport: "http", url: "https://provider.test/mcp", authMode: "oauth", oauth })] });
  const renderer = await mount(api);
  try {
    const label = `Files · ${t.enableService}`;
    for (const enabled of [true, false]) {
      await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onClick(); await flush(); });
      await act(async () => { await flush(); });
      assert.equal(renderer.root.findByProps({ "aria-label": label }).props["aria-checked"], enabled);
      const write = api.calls.filter(call => call.method === "PUT" && call.path === `/api/mcp/servers/${SERVER_ID}`).at(-1)!;
      const input = write.body as { authMode: string; enabled: boolean; oauth: unknown; transport: string; url: string };
      assert.equal(input.enabled, enabled);
      assert.equal(input.authMode, "oauth");
      assert.equal(input.transport, "http");
      assert.equal(input.url, "https://provider.test/mcp");
      assert.deepEqual(input.oauth, oauth, "retain OAuth configuration and the stored-secret sentinel on both transitions");
    }
    assert.equal(api.calls.some(call => call.method === "PUT" && call.path === "/api/settings"), false);
  } finally { renderer.unmount(); }
});

test("a refused list enable keeps the saved state and can be retried", async () => {
  const options = { servers: [server({ enabled: false, status: "disabled", command: "node" })], updateError: "enable refused" as string | undefined };
  const api = fakeClient(options);
  const renderer = await mount(api);
  const label = `Files · ${t.enableService}`;
  await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onClick(); await flush(); });
  assert.equal(renderer.root.findByProps({ "aria-label": label }).props["aria-checked"], false);
  assert.match(JSON.stringify(renderer.toJSON()), /enable refused/);
  options.updateError = undefined;
  await act(async () => { renderer.root.findByProps({ "aria-label": label }).props.onClick(); await flush(); });
  await act(async () => { await flush(); });
  assert.equal(renderer.root.findByProps({ "aria-label": label }).props["aria-checked"], true);
  renderer.unmount();
});
