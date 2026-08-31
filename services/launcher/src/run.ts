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
 * `ScienceDiscovery run`: drive an agent run via a running `serve`, as the
 * command-line twin of the Web UI. Connects to the control plane the browser
 * uses, so behavior stays identical (zero backend customization).
 *
 * Output:
 *  - text mode (default when a TTY is attached): answer text streams to
 *    stdout, status and progress go to stderr. `run "问题" > answer.md`
 *    keeps the answer clean.
 *  - jsonl mode (default when piped): every event is one JSON line on stdout,
 *    including errors (mapped from the backend's `run.failed`). Downstream
 *    `jq` never sees a non-JSON line.
 */
import { createInterface } from "node:readline/promises";

import { AUTH_TOKEN_FILE, resolveBootstrapToken } from "./bootstrap-tokens.js";
import type { RunSettings } from "./cli-options.js";
import {
  ApiRequestError,
  ControlPlaneClient,
  type RunStreamEvent,
  type SessionRun,
} from "./control-plane-client.js";
import type { ServeSettings } from "./serve.js";

export interface RunContext {
  settings: ServeSettings;
  runSettings: RunSettings;
  baseEnv: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number;
}

interface ResolvedInput {
  content: string;
  references?: unknown[];
  modelId?: string;
  enabledSkillIds?: string[];
  enabledConnectorIds?: string[];
  approvalMode?: string;
  reviewMode?: string;
  sessionId?: string;
  projectId?: string;
}

async function readRawInput(runSettings: RunSettings): Promise<string> {
  if (runSettings.stdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (runSettings.input !== undefined) return runSettings.input;
  if (runSettings.positional !== undefined) return runSettings.positional;
  return "";
}

async function resolveInput(runSettings: RunSettings): Promise<ResolvedInput> {
  const raw = await readRawInput(runSettings);
  if (!raw) return { content: "" };
  const trimmed = raw.trim();
  // 合法 JSON → 完整输入;否则整串当问题正文
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<ResolvedInput>;
      if (typeof parsed.content === "string") return { ...parsed, content: parsed.content };
    } catch {
      // 不是合法 JSON,fallback 当正文
    }
  }
  return { content: raw };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function buildSessionBody(input: ResolvedInput, approvalMode: string, runSettings: RunSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const modelId = runSettings.modelId ?? input.modelId;
  if (modelId) body.modelId = modelId;
  const settingsOverrides: Record<string, unknown> = {};
  if (modelId) settingsOverrides.modelId = modelId;
  const skills = splitList(runSettings.skills) ?? input.enabledSkillIds;
  if (skills) settingsOverrides.enabledSkillIds = skills;
  const connectors = splitList(runSettings.connectors) ?? input.enabledConnectorIds;
  if (connectors) settingsOverrides.enabledConnectorIds = connectors;
  if (Object.keys(settingsOverrides).length) body.settingsOverrides = settingsOverrides;
  body.approvalMode = approvalMode;
  const review = runSettings.review ?? input.reviewMode;
  if (review) body.reviewMode = review;
  return body;
}

function buildSettingsOverrides(runSettings: RunSettings, input: ResolvedInput): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const modelId = runSettings.modelId ?? input.modelId;
  if (modelId) overrides.modelId = modelId;
  const skills = splitList(runSettings.skills) ?? input.enabledSkillIds;
  if (skills) overrides.enabledSkillIds = skills;
  const connectors = splitList(runSettings.connectors) ?? input.enabledConnectorIds;
  if (connectors) overrides.enabledConnectorIds = connectors;
  return overrides;
}

function emitJsonlError(payload: { message: string; code?: string; runId?: string; sessionId?: string }): void {
  process.stdout.write(JSON.stringify({ type: "error", ...payload }) + "\n");
}

export async function runCommand(context: RunContext, log: (message: string) => void): Promise<RunResult> {
  const { settings, runSettings, baseEnv } = context;

  // 1. 解析输入
  const input = await resolveInput(runSettings);
  if (!input.content || input.content.trim() === "") {
    throw new Error("run requires a problem text. Provide it as a positional argument, --content, or --stdin.");
  }

  // 2. token + baseUrl
  const token = runSettings.token
    || resolveBootstrapToken(settings.dataDir, AUTH_TOKEN_FILE, baseEnv.SCIENCE_AGENT_AUTH_TOKEN).token;
  const host = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host;
  const baseUrl = `http://${host}:${settings.port}`;

  // 3. 输出模式 + 交互性
  const isTty = Boolean(process.stdout.isTTY);
  const outputMode = runSettings.output ?? (isTty ? "text" : "jsonl");
  const autoApprove =
    runSettings.autoApprove || runSettings.approval === "always_allow" || input.approvalMode === "always_allow";
  const approvalMode = autoApprove
    ? "always_allow"
    : (runSettings.approval ?? input.approvalMode ?? "ask_for_dangerous");
  const interactive = isTty && !autoApprove;

  // 非交互式 + 无 auto-approve 拒启
  if (!interactive && !autoApprove) {
    const msg = "run in non-interactive mode requires --auto-approve (or --approval always_allow); otherwise the task would block on a permission prompt with no one to answer it.";
    if (outputMode === "text") process.stderr.write(`${msg}\n`);
    else emitJsonlError({ message: msg, code: "NON_INTERACTIVE_NO_AUTO_APPROVE" });
    return { exitCode: 1 };
  }

  const client = new ControlPlaneClient({ baseUrl, token });

  // 4. 探活
  const healthy = await client.health();
  if (!healthy) {
    const msg = `Could not reach ScienceDiscovery serve at ${baseUrl}. Start it with: ScienceDiscovery serve`;
    if (outputMode === "text") process.stderr.write(`${msg}\n`);
    else emitJsonlError({ message: msg, code: "ECONNREFUSED" });
    return { exitCode: 1 };
  }

  // 元信息行
  if (outputMode === "text") {
    log(`[run] serve=${baseUrl} approval=${approvalMode} interactive=${interactive}`);
  } else {
    process.stdout.write(JSON.stringify({ type: "meta", baseUrl, approvalMode, interactive }) + "\n");
  }

  // 5. 建/复用项目与会话
  let projectId = runSettings.projectId ?? input.projectId;
  let sessionId = runSettings.sessionId ?? input.sessionId;

  if (!projectId && !sessionId) {
    const created = await client.createProject({ name: "cli" });
    projectId = String(created.id ?? created.project?.id ?? "");
    sessionId = String(created.firstSession?.id ?? "");
  }
  if (!sessionId && projectId) {
    const session = await client.createSession(projectId, buildSessionBody(input, approvalMode, runSettings));
    sessionId = session.id;
  } else if (sessionId) {
    // 复用已有会话:分次写设置(approvalMode 必须单独 PATCH,后端既有约束)
    const overrides = buildSettingsOverrides(runSettings, input);
    if (Object.keys(overrides).length) {
      await client.replaceSessionSettings(sessionId, overrides);
    }
    if (autoApprove || runSettings.approval || input.approvalMode) {
      await client.updateSession(sessionId, { approvalMode });
    }
    const review = runSettings.review ?? input.reviewMode;
    if (review) {
      await client.updateSession(sessionId, { reviewMode: review });
    }
  }
  if (!sessionId) throw new Error("internal: failed to resolve session");

  if (outputMode === "text") {
    log(`[run] project=${projectId ?? "—"} session=${sessionId}`);
  } else {
    process.stdout.write(JSON.stringify({ type: "session", sessionId, projectId: projectId ?? null }) + "\n");
  }

  // 6. 发任务
  const run = await client.createRun(sessionId, { content: input.content, references: input.references ?? [] });
  if (outputMode === "text") {
    log(`[run] run=${run.id} status=${run.status}`);
  } else {
    process.stdout.write(JSON.stringify({ type: "run", runId: run.id, sessionId, status: run.status }) + "\n");
  }

  // 7. 接收事件流
  let exitCode = 0;
  let finalStatus = run.status;
  let finalError: string | undefined;
  let finalFiles: unknown[] | undefined;
  let finalMessageContent: string | undefined;
  let hasStreamedDelta = false;
  let timedOut = false;
  const abortController = new AbortController();

  const timeoutTimer = runSettings.timeout
    ? setTimeout(() => {
        timedOut = true;
        abortController.abort();
        void client.cancelRun(sessionId!, run.id).catch(() => undefined);
      }, runSettings.timeout)
    : undefined;

  // SIGINT → cancel: 先本地置位 finalStatus,让汇总走 cancelled 分支(exit 130),
  // 否则 SSE 连接一断、后端 run.cancelled 事件收不到,会卡在初态导致 exitCode 0。
  const onSigInt = () => {
    finalStatus = "cancelled";
    abortController.abort();
    void client.cancelRun(sessionId!, run.id).catch(() => undefined);
  };
  process.on("SIGINT", onSigInt);

  // text 模式的权限交互(交互式才会走到这)
  const permissionPrompt = async (request: { id: string; [key: string]: unknown }): Promise<void> => {
    if (!interactive) return;
    const action = String(request.action ?? request.tool ?? "this action");
    const resource = String(request.resource ?? "");
    process.stderr.write(`\n[permission] ${action}${resource ? ` on ${resource}` : ""}\n`);
    process.stderr.write(`  1) allow once\n  2) allow and remember this session\n  3) deny\n`);
    let decision: "allow_once" | "allow_matching" | "deny" = "deny";
    try {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question("Choose [1-3]: ");
        if (answer.trim() === "1") decision = "allow_once";
        else if (answer.trim() === "2") decision = "allow_matching";
        else decision = "deny";
      } finally {
        rl.close();
      }
    } catch {
      // stdin 不可读(被管道占用等)→ 默认拒绝
    }
    await client.decidePermissionRequest(request.id, decision);
  };

  const handleEvent = (event: RunStreamEvent): void => {
    switch (event.type) {
      case "run.queued":
      case "run.started":
        if (outputMode === "text") log(`[status] ${event.type}`);
        else process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "run.status":
        if (outputMode === "text") {
          log(`[status] ${String(event.status)}${event.reason ? ` (${String(event.reason)})` : ""}`);
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "agent.phase":
        if (outputMode === "text") log(`[phase] ${String(event.phase)} turn ${Number(event.turn)}`);
        else process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "assistant.delta":
        if (outputMode === "text") {
          process.stdout.write(String(event.delta));
          hasStreamedDelta = true;
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "assistant.snapshot":
        // text 模式靠 delta 流式 + run.completed 兜底,这里不重复
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "assistant.thinking.delta":
      case "assistant.thinking.snapshot":
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "tool.started":
        if (outputMode === "text") {
          log(`[tool] ${String((event.trace as { name?: string })?.name ?? "started")}`);
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "tool.completed":
        if (outputMode === "text") log(`[tool] done`);
        else process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "tool.output":
        if (outputMode === "text") process.stderr.write(`${String(event.chunk)}`);
        else process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "artifact.upserted":
        if (outputMode === "text") {
          log(`[artifact] ${String((event.artifact as { logicalName?: string })?.logicalName ?? "upserted")}`);
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "workspace.changed":
        if (outputMode === "text") {
          log(`[workspace] ${Array.isArray(event.changedPaths) ? (event.changedPaths as string[]).length : 0} files`);
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "permission.required":
        if (outputMode === "text") {
          // 异步弹选择;不阻塞事件循环的返回
          void permissionPrompt(event.request as { id: string; [key: string]: unknown });
        } else {
          // jsonl 非交互式不应进这(auto-approve);若进了,透传
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "permission.resolved":
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "run.history.truncated":
        if (outputMode === "text") {
          log(`[warn] history truncated, ${Number(event.droppedEvents)} events dropped`);
        } else {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
        break;
      case "run.completed":
        finalStatus = "completed";
        finalFiles = event.files as unknown[];
        finalMessageContent = (event.message as { content?: string } | undefined)?.content;
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
      case "run.failed":
        finalStatus = "failed";
        finalError = String(event.error);
        if (outputMode === "text") {
          // 汇总阶段输出
        } else {
          // jsonl:映射为 error 事件(§5.2 错误统一 type)
          process.stdout.write(
            JSON.stringify({ type: "error", message: event.error, code: event.errorCode, runId: run.id, sessionId }) + "\n",
          );
        }
        break;
      case "run.cancelled":
        finalStatus = "cancelled";
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
      default:
        if (outputMode !== "text") process.stdout.write(JSON.stringify(event) + "\n");
        break;
    }
  };

  try {
    await client.subscribeRunEvents(
      sessionId,
      run.id,
      0,
      (event) => handleEvent(event),
      abortController.signal,
    );
  } catch (err) {
    if (!abortController.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      if (outputMode === "text") {
        process.stderr.write(`[error] ${msg}\n`);
      } else {
        emitJsonlError({
          message: msg,
          code: err instanceof ApiRequestError ? err.code : "STREAM_ERROR",
          runId: run.id,
          sessionId,
        });
      }
      finalStatus = "failed";
      finalError = msg;
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.off("SIGINT", onSigInt);
  }

  // 8. 取 usage(后端 SSE 不含,§5.2 汇总行另取)——走 Web 同一条用量接口 /api/sessions/:id/usage
  let usage: unknown = null;
  if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "cancelled") {
    try {
      usage = await client.getSessionUsage(sessionId);
    } catch {
      // 用量取不到不阻塞
    }
  }

  // 9. 输出汇总 + 退出码
  if (outputMode === "text") {
    if (finalStatus === "completed") {
      if (!hasStreamedDelta && finalMessageContent) {
        process.stdout.write(`${finalMessageContent}\n`);
      }
      log(`[run] completed`);
    } else if (finalStatus === "failed") {
      process.stderr.write(`[run] failed: ${finalError ?? "unknown error"}\n`);
      exitCode = 1;
    } else if (finalStatus === "cancelled") {
      process.stderr.write(`[run] cancelled\n`);
      exitCode = 130;
    } else if (timedOut) {
      process.stderr.write(`[run] timed out\n`);
      exitCode = 1;
    }
  } else {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        runId: run.id,
        sessionId,
        status: timedOut ? "timed_out" : finalStatus,
        content: finalMessageContent ?? null,
        files: finalFiles ?? null,
        error: finalError ?? null,
        usage,
      }) + "\n",
    );
    if (finalStatus === "failed") exitCode = 1;
    else if (finalStatus === "cancelled") exitCode = 130;
    else if (timedOut) exitCode = 1;
  }

  return { exitCode };
}
