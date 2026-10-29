// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * An in-memory control plane, intercepted in the browser.
 *
 * The desktop app only talks to `/api/**`, so `page.route` is enough to put a
 * workspace of any shape in front of it without running the Python service.
 * The fixture is stateful for the writes the current specs exercise —
 * renaming, deleting and creating a Session — so a reload can prove the write
 * reached the server rather than only the local state.
 *
 * Routes not modelled here fail loudly with `not mocked`; a silent empty
 * answer would let a spec pass while the app was calling an endpoint nobody
 * taught the mock about.
 */
import type { Page, Route } from "@playwright/test";

export const TOKEN = "e2e-token";
export const TOKEN_STORAGE_KEY = "sciencediscovery-token";
/** `GUIDE_STORAGE_KEY` in `src/state/storage.ts`. Spelled out rather than
 *  imported because these specs do not load the app's module graph; the
 *  string is the contract between them. */
export const GUIDE_STORAGE_KEY = "sciencediscovery-desktop:guide";

export const CREATED_AT = "2026-10-01T08:00:00.000Z";
const UPDATED_AT = "2026-10-01T09:30:00.000Z";

export interface ProjectRecord {
  createdAt: string;
  id: string;
  name: string;
  /** The Runner allowlist. Absent means the server's legacy default, which
   *  includes the local machine implicitly. */
  remoteRunnerHostIds?: string[];
  runnerIds?: string[];
  updatedAt: string;
}

/** A file body the mock serves as-is. A picture, a PDF or a workbook is not
 *  text, so the spec says both the bytes and the type the server would send —
 *  which for these extensions is the type the app has to trust. */
export interface FileContent {
  body: Buffer | string;
  contentType: string;
}

export interface SessionRecord {
  archivedAt?: string;
  createdAt: string;
  id: string;
  messages?: unknown[];
  modelId?: string;
  projectId: string;
  title: string;
  updatedAt: string;
}

/** The title the service stores for a Session nobody has written in yet. */
const UNTITLED_TITLE = "Untitled session";

export interface ModelRecord {
  id: string;
  model: string;
  name: string;
  providerId?: string;
}

/** The settings records are read whole by their page; a fixture supplies the
 *  fields that page prints and leaves the rest to the component's defaults. */
export type JsonRecord = Record<string, any>;

/** One run a Session already took: the row `GET .../runs` lists, and the event
 *  bodies its log holds in the order the server wrote them.
 *
 *  The `run` row is what makes the app replay the log at all — it is listed,
 *  found terminal, and then read back whole with `?after=0`. The wrapper fields
 *  a `SessionRunEvent` also carries (`runId`, `sessionId`, `sequence`) are the
 *  fixture's to add, because the order of `events` already says the sequence. */
export interface ReplayRecord {
  events: JsonRecord[];
  run: JsonRecord;
}

export interface MockOptions {
  /** Fail the health probe, for the offline screen. */
  healthStatus?: number;
  /** Fail the first authenticated read, for the rejected-credential screen. */
  modelsStatus?: number;
  models?: ModelRecord[];
  overrides?: Record<string, unknown>;
  projects?: ProjectRecord[];
  sessions?: SessionRecord[];
  artifacts?: unknown[];
  /** One Session's outputs, for the cases where the panel has to draw more
   *  than one group. Takes precedence over `artifacts` for that Session. */
  artifactsBySession?: Record<string, unknown[]>;
  /** The bytes behind `GET .../artifact-versions/:id/content`, keyed by version
   *  id. A version with no entry reads as empty. */
  artifactContents?: Record<string, string>;
  files?: unknown[];
  /** The runs each Session already took, keyed by Session id. A Session with no
   *  entry has taken none, which is the fresh workspace every other spec opens
   *  on. The transcript is rebuilt from these alone — the stored messages stay
   *  as they were listed. */
  runsBySession?: Record<string, ReplayRecord[]>;
  /** The catalog behind `GET .../subagents`, keyed by Session id. It is the only
   *  place a replayed child's steps live, so a spec that opens one needs both
   *  the snapshot in the run's log and the row here. */
  subagentsBySession?: Record<string, JsonRecord[]>;
  /** The bytes behind `GET .../file?path=`, keyed by workspace path. A path
   *  with no entry reads as the fixture's small CSV. A string is served as
   *  `text/plain`; `FileContent` carries bytes of its own type. */
  fileContents?: Record<string, FileContent | string>;
  runners?: unknown[];
  connectors?: JsonRecord[];
  skills?: JsonRecord[];
  specialists?: JsonRecord[];
  mcpServers?: JsonRecord[];
  mcpSources?: JsonRecord[];
  timeouts?: Record<string, number>;
  projectSettings?: JsonRecord;
  /** The entries `GET /api/remote-hosts/ssh-config` offers to import. */
  sshConfig?: JsonRecord[];
  /** The NPU catalog behind `GET /api/runners/npu`. */
  npuDevices?: JsonRecord;
  /** The key a newly registered or probed machine presents. Its presence makes
   *  the record untrusted until the trust route accepts it. */
  hostKey?: JsonRecord;
  /** Lines `GET /api/runners/:id/connect-log` answers, for a failed connect. */
  connectLog?: string[];
  /** Makes every connect fail with this reason, leaving the log on screen. */
  connectError?: string;
  /** Make one write fail, for the "the reason stays on screen" cases. */
  fail?: { method: string; path: string | RegExp; status?: number; message?: string };
  /** What `POST /api/mcp/servers/:id/test` answers. The default is a healthy
   *  server; `error` is the provider's own refusal, not an HTTP failure. */
  mcpTest?: "error" | "ok";
  /** What `POST /api/models/:id/test` answers. */
  modelTest?: { category?: string; latencyMs?: number; message?: string; ok: boolean };
  /** The sandbox network policy behind 设置 › 网络. 开放网络 by default, so a
   *  spec can save something by moving to 无网络 — the only info-tone notice the
   *  app raises now that an upload is reported by its card. */
  sandboxNetwork?: { allowedDomains: string[]; mode: string };
  /** File names the upload route refuses per file, with a reason of its own.
   *  Mutable through `Mock.state` so a spec can watch the tray's 重试 succeed on
   *  the second attempt — the route answering "no" once is the only way to get
   *  a failed card without also failing the request. */
  uploadRejects?: string[];
  /** Whether the browser has already read the first-run guide. Every spec but
   *  the guide's own is about a returning user, and the guide covers the page
   *  it would otherwise have to click through. Set `false` to get the guide. */
  guideSeen?: boolean;
}

export interface RecordedCall {
  body?: string;
  method: string;
  path: string;
}

export interface MockState {
  artifacts: unknown[];
  connectors: JsonRecord[];
  files: unknown[];
  mcpServers: JsonRecord[];
  models: ModelRecord[];
  overrides: Record<string, unknown>;
  projectSettings: JsonRecord;
  projects: ProjectRecord[];
  providers: Record<string, unknown>[];
  /** Every registered Runner, the local entry included. The local one is not a
   *  remote host and is added by the fixture rather than by a spec. */
  runners: JsonRecord[];
  /** Which NPU cards each Runner may hand to a sandbox. */
  npuSelections: Record<string, number[]>;
  /** 设置 › 网络's sandbox policy. A `PUT` replaces it, so a spec can read back
   *  what the page wrote. */
  sandboxNetwork: { allowedDomains: string[]; mode: string };
  sessions: SessionRecord[];
  skills: JsonRecord[];
  specialists: JsonRecord[];
  timeouts: Record<string, number>;
  /** Names the upload route refuses, per file. See `MockOptions.uploadRejects`. */
  uploadRejects: string[];
}

export interface Mock {
  calls: RecordedCall[];
  state: MockState;
}

const DEFAULT_MODEL: ModelRecord = {
  id: "model-1",
  model: "qwen-max",
  name: "Qwen Max",
  providerId: "provider-1",
};

export const DEFAULT_PROJECT: ProjectRecord = {
  createdAt: CREATED_AT,
  id: "project-1",
  name: "默认项目",
  updatedAt: UPDATED_AT,
};

/** The Project standalone conversations live in. Its name is never shown — the
 *  interface calls it 最近会话 — so only its id matters here. */
export const INBOX_PROJECT: ProjectRecord = {
  createdAt: CREATED_AT,
  id: "inbox-1",
  name: "未归档",
  updatedAt: UPDATED_AT,
};

export function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    createdAt: CREATED_AT,
    id: "session-1",
    modelId: DEFAULT_MODEL.id,
    projectId: DEFAULT_PROJECT.id,
    title: "晶体结构分析",
    updatedAt: UPDATED_AT,
    ...over,
  };
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    status,
  });
}

export async function installMockApi(page: Page, options: MockOptions = {}): Promise<Mock> {
  // Seeded before the app's first script runs, which is the only moment the
  // guide's decision is made. A spec that wants the guide passes `guideSeen:
  // false`; the rest get the page without it.
  if (options.guideSeen !== false) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [GUIDE_STORAGE_KEY, "1"] as const,
    );
  }

  const state: MockState = {
    artifacts: [...(options.artifacts ?? [])],
    connectors: [...(options.connectors ?? [])],
    files: [...(options.files ?? [])],
    mcpServers: [...(options.mcpServers ?? [])],
    models: [...(options.models ?? [DEFAULT_MODEL])],
    overrides: { ...options.overrides },
    projectSettings: {
      effective: { enabledSkillIds: [] },
      overrides: {},
      sources: {},
      ...(options.projectSettings ?? {}),
    },
    projects: [...(options.projects ?? [DEFAULT_PROJECT])],
    providers: [],
    runners: structuredClone(options.runners ?? []) as JsonRecord[],
    npuSelections: {},
    sandboxNetwork: structuredClone(options.sandboxNetwork ?? { allowedDomains: [], mode: "open" }),
    sessions: [...(options.sessions ?? [])],
    skills: [...(options.skills ?? [])],
    specialists: [...(options.specialists ?? [])],
    uploadRejects: [...(options.uploadRejects ?? [])],
    timeouts: {
      gatewayIdleTimeoutMs: 240_000,
      gatewayTurnTimeoutMs: 0,
      kernelIdleTimeoutMs: 0,
      permissionWaitTimeoutMs: 0,
      runnerExecTimeoutMs: 0,
      ...(options.timeouts ?? {}),
    },
  };
  const calls: RecordedCall[] = [];

  // Match the API by its path, not by a `**/api/**` glob: that glob also
  // matches Vite's own module URLs (`/src/api/client.ts`), which would make
  // the mock answer the app's source code with a 404.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const path = decodeURIComponent(url.pathname);
      const body = request.postData() ?? undefined;
      calls.push({ body, method, path });

      if (
        options.fail !== undefined
        && options.fail.method === method
        && (typeof options.fail.path === "string" ? options.fail.path === path : options.fail.path.test(path))
      ) {
        return json(route, options.fail.status ?? 500, {
          error: options.fail.message ?? "the server refused this write",
        });
      }

      if (path === "/api/health") {
        if (options.healthStatus !== undefined && options.healthStatus >= 400) {
          return json(route, options.healthStatus, { error: "control plane unavailable" });
        }
        return json(route, 200, {
          status: "ok",
          workspace: { maxFileBytes: 10 * 1024 * 1024 },
        });
      }

      if (path === "/api/models" && method === "GET") {
        if (options.modelsStatus !== undefined && options.modelsStatus >= 400) {
          return json(route, options.modelsStatus, { error: "token rejected" });
        }
        return json(route, 200, state.models);
      }

      if (path === "/api/settings" && method === "GET") {
        return json(route, 200, {
          effective: {},
          // The initial default is what the first boot would adopt from the
          // catalog; a spec that needs a different one passes `overrides`.
          overrides: { modelId: state.models[0]?.id, ...state.overrides },
          sources: {},
        });
      }

      if (path === "/api/settings" && method === "PUT") {
        // `PUT` replaces the whole override object, so the mock does too.
        state.overrides = JSON.parse(body ?? "{}") as Record<string, unknown>;
        return json(route, 200, { effective: {}, overrides: state.overrides, sources: {} });
      }

      if (path === "/api/providers" && method === "GET") {
        return json(route, 200, { presets: [], providers: state.providers });
      }

      if (path === "/api/providers" && method === "POST") {
        const input = JSON.parse(body ?? "{}") as Record<string, unknown>;
        // The form saves before testing and again before continuing, so the
        // server's own idempotence is part of what this mock has to reproduce.
        const existing = state.providers.find(
          (entry) => entry.baseUrl === input.baseUrl && entry.presetId === input.presetId,
        );
        if (existing) return json(route, 200, existing);
        const provider = { ...input, id: `provider-${state.providers.length + 1}` };
        state.providers.push(provider);
        return json(route, 201, provider);
      }

      const providerRoute = /^\/api\/providers\/([^/]+)$/.exec(path);
      if (providerRoute && method === "PUT") {
        const input = JSON.parse(body ?? "{}") as Record<string, unknown>;
        const index = state.providers.findIndex((entry) => entry.id === providerRoute[1]);
        if (index === -1) return json(route, 404, { error: "provider not found" });
        state.providers[index] = { ...state.providers[index], ...input };
        return json(route, 200, state.providers[index]);
      }

      if (path === "/api/providers/preview-models" && method === "POST") {
        return json(route, 200, { models: [] });
      }

      const providerModel = /^\/api\/providers\/([^/]+)\/models$/.exec(path);
      if (providerModel && method === "POST") {
        const provider = state.providers.find((entry) => entry.id === providerModel[1]);
        const input = JSON.parse(body ?? "{}") as { model?: string };
        const existing = state.models.find(
          (entry) => entry.providerId === providerModel[1] && entry.model === input.model,
        );
        if (existing) return json(route, 200, existing);
        const profile: ModelRecord = {
          id: `model-${state.models.length + 1}`,
          model: input.model ?? "",
          name: String(provider?.name ?? "自定义网关"),
          providerId: providerModel[1],
        };
        state.models.push(profile);
        return json(route, 201, profile);
      }

      const testModel = /^\/api\/models\/([^/]+)\/test$/.exec(path);
      if (testModel && method === "POST") {
        return json(route, 200, options.modelTest ?? {
          category: "ok",
          latencyMs: 12,
          message: "",
          ok: true,
        });
      }

      const modelRecord = /^\/api\/models\/([^/]+)$/.exec(path);
      if (modelRecord && method === "DELETE") {
        const index = state.models.findIndex((profile) => profile.id === modelRecord[1]);
        if (index === -1) return json(route, 404, { error: "model not found" });
        state.models.splice(index, 1);
        return json(route, 200, { deleted: modelRecord[1] });
      }

      if (path === "/api/connectors" && method === "GET") {
        return json(route, 200, state.connectors);
      }

      if (path === "/api/skills" && method === "GET") {
        return json(route, 200, state.skills);
      }

      const projectSettings = /^\/api\/projects\/([^/]+)\/settings$/.exec(path);
      if (projectSettings) {
        if (method === "GET") return json(route, 200, state.projectSettings);
        if (method === "PUT") {
          const overrides = JSON.parse(body ?? "{}") as JsonRecord;
          state.projectSettings = {
            effective: {
              enabledSkillIds: overrides.enabledSkillIds ?? [],
              skillSelectionMode: overrides.skillSelectionMode,
            },
            overrides,
            sources: {},
          };
          return json(route, 200, state.projectSettings);
        }
      }

      if (path === "/api/specialists" && method === "GET") {
        return json(route, 200, state.specialists);
      }

      if (path === "/api/specialists" && method === "POST") {
        const input = JSON.parse(body ?? "{}") as JsonRecord;
        const specialist = {
          createdAt: CREATED_AT,
          enabled: true,
          id: `specialist-${state.specialists.length + 1}`,
          updatedAt: UPDATED_AT,
          ...input,
        };
        state.specialists.push(specialist);
        return json(route, 201, specialist);
      }

      const specialist = /^\/api\/specialists\/([^/]+)$/.exec(path);
      if (specialist) {
        const index = state.specialists.findIndex((entry) => entry.id === specialist[1]);
        if (index === -1) return json(route, 404, { error: "specialist not found" });
        if (method === "PUT") {
          state.specialists[index] = {
            ...state.specialists[index],
            ...JSON.parse(body ?? "{}"),
            updatedAt: UPDATED_AT,
          };
          return json(route, 200, state.specialists[index]);
        }
        if (method === "DELETE") {
          state.specialists.splice(index, 1);
          return json(route, 200, { deleted: specialist[1] });
        }
      }

      if (path === "/api/mcp/sources" && method === "GET") {
        return json(route, 200, options.mcpSources ?? []);
      }

      if (path === "/api/mcp/servers" && method === "GET") {
        return json(route, 200, state.mcpServers);
      }

      if (path === "/api/mcp/servers" && method === "POST") {
        const input = JSON.parse(body ?? "{}") as JsonRecord;
        const server = {
          checkedAt: CREATED_AT,
          durationMs: 4,
          error: undefined,
          id: `mcp-${state.mcpServers.length + 1}`,
          sourceId: `custom-${state.mcpServers.length + 1}`,
          status: "ready",
          tools: [],
          ...input,
        };
        state.mcpServers.push(server);
        return json(route, 201, server);
      }

      const testMcp = /^\/api\/mcp\/servers\/([^/]+)\/test$/.exec(path);
      if (testMcp && method === "POST") {
        const server = state.mcpServers.find((entry) => entry.id === testMcp[1]);
        if (server === undefined) return json(route, 404, { error: "mcp server not found" });
        if (options.mcpTest === "error") {
          server.status = "error";
          server.error = "connection refused";
        } else {
          server.status = "ready";
          server.error = undefined;
        }
        server.checkedAt = UPDATED_AT;
        return json(route, 200, server);
      }

      const mcpServer = /^\/api\/mcp\/servers\/([^/]+)$/.exec(path);
      if (mcpServer) {
        const index = state.mcpServers.findIndex((entry) => entry.id === mcpServer[1]);
        if (index === -1) return json(route, 404, { error: "mcp server not found" });
        if (method === "PUT") {
          state.mcpServers[index] = { ...state.mcpServers[index], ...JSON.parse(body ?? "{}") };
          return json(route, 200, state.mcpServers[index]);
        }
        if (method === "DELETE") {
          state.mcpServers.splice(index, 1);
          return json(route, 200, { deleted: true });
        }
      }

      if (path === "/api/timeout-settings" && method === "GET") {
        return json(route, 200, state.timeouts);
      }

      if (path === "/api/timeout-settings" && method === "PUT") {
        state.timeouts = JSON.parse(body ?? "{}") as Record<string, number>;
        return json(route, 200, state.timeouts);
      }

      if (path === "/api/sandbox-network-settings" && method === "GET") {
        return json(route, 200, state.sandboxNetwork);
      }

      if (path === "/api/sandbox-network-settings" && method === "PUT") {
        state.sandboxNetwork = JSON.parse(body ?? "{}") as MockState["sandboxNetwork"];
        return json(route, 200, state.sandboxNetwork);
      }

      if (path === "/api/projects" && method === "GET") {
        return json(route, 200, state.projects);
      }

      // The inbox is a Project the server keeps but leaves out of the list; the
      // app asks for it by this route at boot and files standalone Sessions in
      // it, so a mock without it stops the workspace from opening at all.
      if (path === "/api/inbox" && method === "POST") {
        return json(route, 200, INBOX_PROJECT);
      }

      if (path === "/api/projects" && method === "POST") {
        const project: ProjectRecord = {
          createdAt: CREATED_AT,
          id: `project-${state.projects.length + 1}`,
          name: JSON.parse(body ?? "{}").name ?? "默认项目",
          updatedAt: UPDATED_AT,
        };
        state.projects.push(project);
        // The server writes a Project's first Session with it, and that Session
        // is untitled until a message names it. A spec can then tell a row the
        // reader asked for from one a button made.
        const firstSession = makeSession({
          id: `session-${state.sessions.length + 1}`,
          projectId: project.id,
          title: UNTITLED_TITLE,
        });
        state.sessions.push(firstSession);
        return json(route, 201, { firstSession, project });
      }

      const projectSessions = /^\/api\/projects\/([^/]+)\/sessions$/.exec(path);
      if (projectSessions) {
        const projectId = projectSessions[1]!;
        if (method === "GET") {
          return json(route, 200, state.sessions.filter((entry) => entry.projectId === projectId));
        }
        if (method === "POST") {
          const created = makeSession({
            id: `session-${state.sessions.length + 1}`,
            projectId,
            title: UNTITLED_TITLE,
          });
          state.sessions.push(created);
          return json(route, 201, created);
        }
      }

      const sessionRoute = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (sessionRoute) {
        const id = sessionRoute[1]!;
        const index = state.sessions.findIndex((entry) => entry.id === id);
        if (index === -1) return json(route, 404, { error: "session not found" });
        if (method === "GET") {
          return json(route, 200, { ...state.sessions[index], messages: state.sessions[index]!.messages ?? [] });
        }
        if (method === "PATCH") {
          const patch = JSON.parse(body ?? "{}") as Partial<SessionRecord>;
          state.sessions[index] = { ...state.sessions[index]!, ...patch };
          return json(route, 200, state.sessions[index]);
        }
        if (method === "DELETE") {
          state.sessions.splice(index, 1);
          return json(route, 200, { deleted: id });
        }
      }

      const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (messages && method === "POST") {
        const session = state.sessions.find((entry) => entry.id === messages[1]);
        if (!session) return json(route, 404, { error: "session not found" });
        const prompt = (JSON.parse(body ?? "{}") as { content?: string }).content ?? "";
        const answer = "晶格常数是 5.43 Å。";
        const userMessage = { content: prompt, createdAt: CREATED_AT, id: "message-user", role: "user" };
        const assistantMessage = {
          content: answer,
          createdAt: CREATED_AT,
          id: "message-assistant",
          role: "assistant",
        };
        session.messages = [...(session.messages ?? []), userMessage, assistantMessage];
        // The service names a Session from its first message and publishes the
        // rename ahead of the run; the mock does both, so a spec can watch the
        // sidebar row appear with the message.
        const renamed = session.title === UNTITLED_TITLE;
        if (renamed) session.title = prompt.trim().slice(0, 24) || session.title;
        const run = {
          createdAt: CREATED_AT,
          finishedAt: CREATED_AT,
          id: "run-1",
          prompt,
          queueOrder: 0,
          sessionId: session.id,
          status: "running",
        };
        return route.fulfill({
          body: sse([
            ...(renamed ? [{ session, type: "session.updated" }] : []),
            { run, type: "run.queued" },
            { model: { name: "Qwen Max" }, runId: "run-1", settings: {}, type: "run.started" },
            { responseId: "response-1", turn: 1, type: "assistant.response.started" },
            { delta: answer, responseId: "response-1", turn: 1, type: "assistant.delta" },
            { files: [], message: assistantMessage, type: "run.completed" },
            { run: { ...run, status: "completed" }, status: "completed", type: "run.status" },
          ]),
          contentType: "text/event-stream",
          status: 200,
        });
      }

      const runs = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path);
      if (runs && method === "GET") {
        return json(route, 200, (options.runsBySession?.[runs[1]!] ?? []).map((entry) => entry.run));
      }

      const runEvents = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/events$/.exec(path);
      if (runEvents && method === "GET") {
        const [sessionId, runId] = [runEvents[1]!, runEvents[2]!];
        const entry = (options.runsBySession?.[sessionId] ?? []).find((candidate) => candidate.run.id === runId);
        return json(route, 200, (entry?.events ?? []).map((event, index) => ({
          createdAt: String(entry?.run.createdAt ?? CREATED_AT),
          event,
          runId,
          sequence: index + 1,
          sessionId,
        })));
      }

      const subagents = /^\/api\/sessions\/([^/]+)\/subagents$/.exec(path);
      if (subagents && method === "GET") {
        return json(route, 200, options.subagentsBySession?.[subagents[1]!] ?? []);
      }

      const artifacts = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(path);
      if (artifacts && method === "GET") return json(route, 200, []);

      const outputs = /^\/api\/sessions\/([^/]+)\/artifact-outputs$/.exec(path);
      if (outputs && method === "GET") {
        // The panel reads each Session's list on its own, so a fixture with two
        // Sessions' groups has to say which output belongs to which.
        const perSession = options.artifactsBySession?.[outputs[1]!];
        return json(route, 200, perSession ?? state.artifacts);
      }

      const versionContent = /^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/content$/.exec(path);
      if (versionContent && method === "GET") {
        return route.fulfill({
          body: options.artifactContents?.[versionContent[2]!] ?? "",
          contentType: "text/plain",
          status: 200,
        });
      }

      const files = /^\/api\/sessions\/([^/]+)\/files$/.exec(path);
      if (files && method === "GET") return json(route, 200, state.files);

      const upload = /^\/api\/sessions\/([^/]+)\/workspace\/upload$/.exec(path);
      if (upload && method === "POST") {
        // The filenames live in the multipart framing; reading them back is what
        // lets the result carry the path the server says each file landed on.
        const raw = request.postDataBuffer()?.toString("latin1") ?? "";
        // One match per part, decoded back to UTF-8: the browser writes the
        // filename's bytes as they are, and reading the whole body as latin1 —
        // which is the only way to keep the file bytes intact — would turn
        // 报告.pdf into mojibake on the way out.
        const names = [...raw.matchAll(/name="files"; filename="([^"]*)"/g)]
          .map((match) => Buffer.from(match[1]!, "latin1").toString("utf8"));
        const errors: { error: string; name: string }[] = [];
        const uploaded = names.map((name) => {
          if (state.uploadRejects.includes(name)) {
            errors.push({ error: "refused by the fixture", name });
            return { error: "refused by the fixture", originalName: name, status: "failed" as const };
          }
          const file = { modifiedAt: CREATED_AT, path: name, size: 16 };
          state.files.push(file);
          return { originalName: name, path: name, status: "stored" as const };
        });
        return json(route, 200, { errors, uploaded });
      }

      const file = /^\/api\/sessions\/([^/]+)\/file$/.exec(path);
      if (file && method === "GET") {
        const wanted = url.searchParams.get("path") ?? "";
        const entry = options.fileContents?.[wanted];
        const body = typeof entry === "string" ? entry : entry?.body ?? "a,b\n1,2\n";
        const contentType = typeof entry === "string" ? "text/plain" : entry?.contentType ?? "text/plain";
        return route.fulfill({ body, contentType, status: 200 });
      }

      const cancel = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(path);
      if (cancel && method === "POST") return json(route, 200, { cancelled: true });

      /* -- 远程机器 -------------------------------------------------------- */

      if (path === "/api/runners" && method === "GET") return json(route, 200, state.runners);

      if (path === "/api/runners/npu" && method === "GET") {
        // The local machine has no connection status to carry its inventory, so
        // its cards and every Runner's selection come from their own read.
        return json(route, 200, {
          local: null,
          selections: state.npuSelections,
          ...(options.npuDevices ?? {}),
        });
      }

      const npuDevices = /^\/api\/runners\/([^/]+)\/npu-devices$/.exec(path);
      if (npuDevices && method === "PUT") {
        const devices = (JSON.parse(body ?? "{}") as { devices?: number[] }).devices ?? [];
        state.npuSelections[npuDevices[1]!] = devices;
        return json(route, 200, { devices, runnerId: npuDevices[1] });
      }

      if (path === "/api/remote-hosts/generate-key" && method === "POST") {
        return json(route, 200, {
          privateKeyPath: "/data/keys/generated_ed25519",
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2E e2e@this-host",
        });
      }

      if (path === "/api/remote-hosts/ssh-config" && method === "GET") {
        const alias = url.searchParams.get("alias");
        if (alias === null) return json(route, 200, options.sshConfig ?? []);
        const entry = (options.sshConfig ?? []).find((candidate) => candidate.alias === alias);
        if (entry === undefined) return json(route, 404, { error: "ssh_config entry not found" });
        return json(route, 200, entry);
      }

      if (path === "/api/remote-hosts/key-files" && method === "GET") {
        // Metadata only, like the real route: nothing here reads a key's bytes.
        return json(route, 200, {
          directory: url.searchParams.get("path") ?? "/home/me/.ssh",
          entries: [
            { kind: "file", name: "id_ed25519", path: "/home/me/.ssh/id_ed25519" },
            { kind: "file", name: "id_rsa", path: "/home/me/.ssh/id_rsa" },
          ],
          nextOffset: null,
          parentDirectory: "/home/me",
        });
      }

      if (path === "/api/remote-hosts" && method === "POST") {
        const input = JSON.parse(body ?? "{}") as JsonRecord;
        // `id` is how the trust retry addresses the record the first attempt
        // created; without it this registers a new machine.
        const id = typeof input.id === "string" ? input.id : `runner-${state.runners.length + 1}`;
        const previous = state.runners.find((entry) => entry.id === id);
        const trusted = options.hostKey === undefined || input.trustHostKey !== undefined;
        const record: JsonRecord = {
          alias: input.alias ?? previous?.alias,
          connectionKind: input.connectionKind ?? previous?.connectionKind ?? "ssh",
          createdAt: previous?.createdAt ?? CREATED_AT,
          hasPassword: Boolean(input.password) || Boolean(previous?.hasPassword),
          hasPrivateKey: Boolean(input.privateKeyPath) || Boolean(previous?.hasPrivateKey),
          hasToken: Boolean(input.token) || Boolean(previous?.hasToken),
          id,
          runnerCommand: input.runnerCommand ?? previous?.runnerCommand ?? "sciencediscovery-runner",
          // A machine that has not been trusted has not answered, so it cannot
          // claim the platform Runner execution needs.
          status: trusted ? "ready" : "error",
          updatedAt: UPDATED_AT,
          ...(input.endpoint === undefined ? (previous?.endpoint === undefined ? {} : { endpoint: previous.endpoint }) : { endpoint: input.endpoint }),
          ...(input.port === undefined || input.port === null ? (previous?.port === undefined ? {} : { port: previous.port }) : { port: input.port }),
          ...(input.username === undefined ? (previous?.username === undefined ? {} : { username: previous.username }) : { username: input.username }),
          ...(options.hostKey === undefined
            ? (previous?.hostKey === undefined ? {} : { hostKey: previous.hostKey })
            : { hostKey: { ...options.hostKey, trusted } }),
          ...(trusted ? { capabilities: { platform: "Linux" } } : {}),
          runnerStatus: { hostId: id, state: "disconnected" },
        };
        state.runners = [...state.runners.filter((entry) => entry.id !== id), record];
        return json(route, previous === undefined ? 201 : 200, record);
      }

      const trustHostKey = /^\/api\/remote-hosts\/([^/]+)\/trust-host-key$/.exec(path);
      if (trustHostKey && method === "POST") {
        const index = state.runners.findIndex((entry) => entry.id === trustHostKey[1]);
        if (index === -1) return json(route, 404, { error: "remote host not found" });
        const record = state.runners[index]!;
        state.runners[index] = {
          ...record,
          capabilities: { platform: "Linux" },
          hostKey: { ...(record.hostKey ?? options.hostKey ?? {}), trusted: true },
          status: "ready",
        };
        return json(route, 200, state.runners[index]);
      }

      const credentials = /^\/api\/remote-hosts\/([^/]+)\/credentials$/.exec(path);
      if (credentials && method === "PUT") {
        const index = state.runners.findIndex((entry) => entry.id === credentials[1]);
        if (index === -1) return json(route, 404, { error: "remote host not found" });
        const input = JSON.parse(body ?? "{}") as JsonRecord;
        const record = state.runners[index]!;
        state.runners[index] = {
          ...record,
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.password === undefined ? {} : { hasPassword: input.password !== null }),
          ...(input.privateKeyPath === undefined ? {} : { hasPrivateKey: input.privateKeyPath !== null }),
          updatedAt: UPDATED_AT,
        };
        // The route answers with a fresh probe, so the card shows the new login
        // working rather than merely stored.
        return json(route, 200, state.runners[index]);
      }

      const remoteHost = /^\/api\/remote-hosts\/([^/]+)$/.exec(path);
      if (remoteHost && method === "DELETE") {
        const id = remoteHost[1]!;
        state.runners = state.runners.filter((entry) => entry.id !== id);
        return json(route, 200, { deleted: id });
      }

      const probe = /^\/api\/runners\/([^/]+)\/probe$/.exec(path);
      if (probe && method === "POST") {
        const record = state.runners.find((entry) => entry.id === probe[1]);
        if (record === undefined) return json(route, 404, { error: "runner not found" });
        if (options.hostKey !== undefined && record.hostKey?.trusted !== true) {
          // The key is a question, not a failure: the record comes back with
          // `trusted: false` and the page asks before trying again.
          const challenged = { ...record, hostKey: { ...options.hostKey, trusted: false }, status: "error" };
          const index = state.runners.findIndex((entry) => entry.id === record.id);
          state.runners[index] = challenged;
          return json(route, 200, challenged);
        }
        return json(route, 200, { ...record, runnerStatus: { hostId: record.id, state: "disconnected" } });
      }

      const connectLog = /^\/api\/runners\/([^/]+)\/connect-log$/.exec(path);
      if (connectLog && method === "GET") {
        return json(route, 200, {
          entries: (options.connectLog ?? []).map((line) => ({ at: UPDATED_AT, line })),
          hostId: connectLog[1],
        });
      }

      const connect = /^\/api\/runners\/([^/]+)\/(?:connect|disconnect)$/.exec(path);
      if (connect && method === "POST") {
        const index = state.runners.findIndex((entry) => entry.id === connect[1]);
        if (index === -1) return json(route, 404, { error: "runner not found" });
        const connecting = path.endsWith("/connect");
        if (connecting && options.connectError !== undefined) {
          return json(route, 500, { error: options.connectError });
        }
        const record = state.runners[index]!;
        state.runners[index] = {
          ...record,
          runnerStatus: {
            hostId: record.id,
            ...(connecting ? { connectedAt: UPDATED_AT, remoteVersion: "0.9.0" } : {}),
            state: connecting ? "ready" : "disconnected",
          },
        };
        return json(route, 200, { connected: connecting });
      }

      const project = /^\/api\/projects\/([^/]+)$/.exec(path);
      if (project) {
        const id = project[1]!;
        const index = state.projects.findIndex((entry) => entry.id === id);
        if (index === -1) return json(route, 404, { error: "project not found" });
        if (method === "PATCH") {
          const patch = JSON.parse(body ?? "{}") as JsonRecord;
          state.projects[index] = { ...state.projects[index]!, ...patch, updatedAt: UPDATED_AT };
          return json(route, 200, state.projects[index]);
        }
        if (method === "DELETE") {
          // The server refuses a delete whose body does not repeat the id; a
          // mock that accepted anything would let a broken client pass.
          const { confirmationId } = JSON.parse(body ?? "{}") as { confirmationId?: string };
          if (confirmationId !== id) {
            return json(route, 400, { error: "Project deletion confirmation does not match the target" });
          }
          state.projects.splice(index, 1);
          // A Project takes its Sessions with it.
          state.sessions = state.sessions.filter((session) => session.projectId !== id);
          return json(route, 200, { deleted: id });
        }
      }

      return json(route, 404, { error: `not mocked: ${method} ${path}` });
  });

  return { calls, state };
}
