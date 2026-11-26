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
  importWait?: Promise<void>;
  servers?: unknown[];
  testServer?: Record<string, unknown>;
  updateError?: string;
} = {}) {
  const calls: Call[] = [];
  let imported = 0;
  let records = options.servers ?? [];
  const api = {
    calls,
    request: async (path: string, init?: { body?: string; method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, method, path });
      if (path === "/api/mcp/servers" && method === "GET") return records;
      if (path === "/api/mcp/sources") return [];
      if (path === "/api/settings") return { effective: { enabledConnectorIds: [] }, overrides: {} };
      if (path === "/api/mcp/servers" && method === "POST") {
        if (options.createError !== undefined) throw new Error(options.createError);
        return server({ name: "Files" });
      }
      if (method === "PUT" && path === `/api/mcp/servers/${SERVER_ID}`) {
        if (options.updateError) throw new Error(options.updateError);
        const previous = records.find((item) => (item as { id: string }).id === SERVER_ID) as Record<string, unknown> | undefined;
        const next = server({ ...previous, ...JSON.parse(init?.body ?? "{}") });
        next.status = !next.enabled ? "disabled" : next.checkedAt ? "ready" : "untested";
        records = records.map((item) => (item as { id: string }).id === SERVER_ID ? next : item);
        return next;
      }
      if (path.endsWith("/test")) return server({ tools: [{ annotations: {}, description: "Read a file", inputSchema: {}, name: "read_file", schemaHash: "h" }], ...options.testServer });
      if (path === "/api/mcp/servers/import") {
        imported += 1;
        await options.importWait;
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
  return typeof node === "string" ? node : node.props["aria-hidden"] ? "" : node.children.map((child) => text(child)).join("");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && text(node).trim() === label);
  assert.ok(found.length > 0, `no button labelled ${label}`);
  return found[0]!;
}

function textInputs(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === "input" && !["checkbox", "password", "file"].includes(node.props.type));
}

async function openCreate(renderer: ReactTestRenderer) {
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { button(renderer.root, t.manualEntry).props.onClick(); });
}

async function openImport(renderer: ReactTestRenderer) {
  await act(async () => { button(renderer.root, t.addServer).props.onClick(); });
  await act(async () => { button(renderer.root, t.importChoice).props.onClick(); });
}

async function openRowActions(renderer: ReactTestRenderer) {
  const trigger = renderer.root.findAll(node => node.type === "button"
    && String(node.props.className).includes("skill-row-menu-trigger"))[0];
  assert.ok(trigger, "a server action menu is available");
  if (!trigger.props["aria-expanded"]) await act(async () => { trigger.props.onClick(); });
}

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
  await openRowActions(renderer);
  await act(async () => { button(renderer.root, TEXT.settings.edit).props.onClick(); });
  const checkbox = renderer.root.findAll(node => node.type === "input" && node.props.type === "checkbox" && node.props["aria-label"] === undefined)[0]!;
  assert.equal(checkbox.props.checked, true);
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

async function uploadJson(renderer: ReactTestRenderer, file: Pick<File, "name" | "size" | "text">) {
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
  await openCreate(renderer);
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
  await openCreate(renderer);
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
  await openImport(renderer);
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

  await openRowActions(renderer);
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
  await openRowActions(renderer);
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
  await openCreate(renderer);
  await act(async () => { await flush(); });
  const name = textInputs(renderer.root)[0]!;
  await act(async () => { name.props.onChange({ target: { value: "Files" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  await act(async () => { await flush(); });
  assert.match(JSON.stringify(renderer.toJSON()), /read_file/, "the creation result is on screen");
  await act(async () => { button(renderer.root, t.done).props.onClick(); });
  await act(async () => { await flush(); });

  await openRowActions(renderer);
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
    await openRowActions(renderer);
    assert.equal(button(renderer.root, t.authorize).props.disabled, true, "授权 is locked while consent is pending");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_400)); });
    await act(async () => { await flush(); });
    assert.ok(reads >= 3, `the page re-read the list while authorizing (${reads} reads)`);
    assert.ok(base.calls.some((call) => call.path === `/api/mcp/servers/${SERVER_ID}/test`), "the landed grant is tested");
    await openRowActions(renderer);
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
  await openCreate(renderer);
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
  await openCreate(renderer);
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
    await openRowActions(renderer);
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
      await openRowActions(renderer2);
      await act(async () => { button(renderer2.root, t.authorize).props.onClick(); });
      await act(async () => { await flush(); });
      await openRowActions(renderer2);
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
  await openImport(renderer);
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

test("a JSON file fills and previews the import card without writing before confirmation", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  const config = { mcpServers: {
    Echo: { command: "node", args: ["/srv/my MCP/echo.mjs", ""], env: { LABEL: "a b" } },
    Search: { type: "sse", url: "https://mcp.test/sse", headers: { "X-Test": "fixture" } },
  } };
  const json = JSON.stringify(config);
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => `\uFEFF${json}` });
  assert.equal(renderer.root.findByProps({ "aria-label": t.importJson }).props.value, json);
  assert.match(JSON.stringify(renderer.toJSON()), /Echo/);
  assert.match(JSON.stringify(renderer.toJSON()), /Search/);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  await act(async () => { button(renderer.root, TEXT.settings.cancel).props.onClick(); });
  await openImport(renderer);
  assert.equal(renderer.root.findByProps({ "aria-label": t.importJson }).props.value, "");
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => json });
  await act(async () => { button(renderer.root, t.importRun).props.onClick(); await flush(); });
  const imports = api.calls.filter((call) => call.path === "/api/mcp/servers/import");
  assert.deepEqual(imports.map((call) => call.body), [
    { mcpServers: { Echo: config.mcpServers.Echo } },
    { mcpServers: { Search: config.mcpServers.Search } },
  ]);
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
    assert.equal(button(renderer.root, t.importRun).props.disabled, true);
    await act(async () => { button(renderer.root, TEXT.settings.cancel).props.onClick(); });
  }
  assert.equal(oversizedRead, false);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  await act(async () => renderer.unmount());
});

test("the import card cannot be dismissed or submitted twice while importing", async () => {
  let finish!: () => void;
  const importWait = new Promise<void>((resolve) => { finish = resolve; });
  const api = fakeClient({ importWait });
  const renderer = await mount(api);
  const json = JSON.stringify({ mcpServers: { Echo: { command: "node" } } });
  await uploadJson(renderer, { name: "servers.json", size: json.length, text: async () => json });
  await act(async () => { button(renderer.root, t.importRun).props.onClick(); await flush(); });
  assert.equal(button(renderer.root, TEXT.settings.cancel).props.disabled, true);
  assert.equal(renderer.root.findByProps({ "aria-label": TEXT.settings.close }).props.disabled, true);
  await act(async () => { button(renderer.root, t.importRun).props.onClick(); await flush(); });
  assert.equal(api.calls.filter((call) => call.path === "/api/mcp/servers/import").length, 1);
  await act(async () => { finish(); await flush(); });
  assert.equal(button(renderer.root, TEXT.settings.cancel).props.disabled, false);
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
  await openRowActions(renderer);
  await act(async () => { button(renderer.root, t.test).props.onClick(); await flush(); });
  assert.deepEqual(toasts, [{ message: t.unauthorized, tone: "error" }]);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/test")).length, 1);
  await act(async () => renderer.unmount());
});

test("new MCP defaults are disabled HTTP with 60 seconds and cancel resets input", async () => {
  const api = fakeClient();
  const renderer = await mount(api);
  const open = async () => { await openCreate(renderer); };
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
  await openCreate(renderer);
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
  await openRowActions(renderer);
  await act(async () => { button(renderer.root, TEXT.settings.edit).props.onClick(); });
  assert.equal(renderer.root.findByProps({ "aria-label": t.args }).props.value, args.join("\n"));
  await act(async () => { renderer.root.findByProps({ "aria-label": t.name }).props.onChange({ target: { value: "Renamed" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); });
  const write = api.calls.find((call) => call.method === "PUT");
  assert.deepEqual((write?.body as { args: string[] }).args, args);
  await act(async () => renderer.unmount());
});
