// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { prepareSpecialistLauncher } from "@sciencediscovery/runner";
import type { SpecialistRuntimeAdapter, SpecialistRuntimeRequest, SpecialistEventSink, SpecialistResult } from "./adapter.js";
import { CodexRuntimeError, SpecialistUnavailableError } from "./codex.js";
import { platformDecisionSchema, runPlatformDecisions } from "./decisions.js";

type Kind = "claude-code" | "acp";
/** Executables are operator-controlled absolute paths, never catalog command/argv.
 * ACP args are operator configuration too. Credentials have a separate env slot. */
export interface ProcessRuntimeOptions { binary: string; args?: string[] }
function configured(kind: Kind): ProcessRuntimeOptions {
  const binary = process.env[kind === "acp" ? "SCIENCE_AGENT_ACP_BINARY" : "SCIENCE_AGENT_CLAUDE_BINARY"];
  if (!binary || !isAbsolute(binary)) throw new SpecialistUnavailableError("Configure an absolute Specialist executable path on the server");
  let args: unknown = [];
  try { if (kind === "acp") args = JSON.parse(process.env.SCIENCE_AGENT_ACP_ARGS ?? "[]"); } catch { throw new SpecialistUnavailableError("Invalid operator ACP arguments"); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new SpecialistUnavailableError("Invalid operator ACP arguments");
  return { binary, args };
}

class JsonLines {
  private buffer = "";
  private bytes = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private nextId = 0;
  private failed?: Error;
  onNotification?: (message: any) => void;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > 2_000_000) { this.fail(new CodexRuntimeError("Oversized runtime output")); child.kill("SIGTERM"); return; }
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.method && message.id !== undefined) {
            // ACP permissions do not authorize agent-local execution. No fs or
            // terminal capabilities are advertised; all work uses SD tools.
            this.send(message.method === "session/request_permission"
              ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Use platform tools" } });
          } else if (message.id !== undefined) {
            const pending = this.pending.get(message.id); this.pending.delete(message.id);
            if (message.error) pending?.reject(new SpecialistUnavailableError("ACP provider request failed"));
            else pending?.resolve(message.result);
          } else this.onNotification?.(message);
        } catch { this.fail(new CodexRuntimeError("Invalid runtime protocol output")); }
      }
    });
    child.stderr.resume(); // Provider output can contain secrets; never persist it.
    child.stdin.on("error", () => this.fail(new SpecialistUnavailableError("Runtime input closed")));
    child.on("error", () => this.fail(new SpecialistUnavailableError("Runtime launch failed")));
    child.on("close", () => this.fail(new SpecialistUnavailableError("Runtime exited before completion")));
  }
  fail(error: Error) { this.failed = error; for (const p of this.pending.values()) p.reject(error); this.pending.clear(); }
  send(value: unknown) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  call(method: string, params: unknown): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ jsonrpc: "2.0", id, method, params }); });
  }
}

abstract class ProcessAdapter implements SpecialistRuntimeAdapter {
  abstract readonly kind: Kind;
  constructor(private readonly options?: ProcessRuntimeOptions) {}
  async invoke(request: SpecialistRuntimeRequest, sink: SpecialistEventSink): Promise<SpecialistResult> {
    request.signal.throwIfAborted();
    let credential: string;
    try { credential = await request.credential(); }
    catch { request.signal.throwIfAborted(); throw new SpecialistUnavailableError("Runtime credential channel unavailable"); }
    request.signal.throwIfAborted();
    if (request.execution === "direct") {
      if (!request.authorizeDirect) throw new CodexRuntimeError("Direct execution requires direct_code consent");
      await request.authorizeDirect();
    }
    const root = await mkdtemp(join(tmpdir(), "sd-specialist-"));
    const children = new Set<ChildProcessWithoutNullStreams>();
    const stop = () => { for (const child of children) child.kill("SIGTERM"); };
    request.signal.addEventListener("abort", stop, { once: true });
    let launched = false;
    const result: SpecialistResult = { summary: "", artifacts: [] };
    try {
      const options = this.options ?? configured(this.kind);
      if (credential && (options.args?.some(arg => arg.includes(credential)) || request.model?.includes(credential))) throw new CodexRuntimeError("Credentials cannot enter runtime arguments");
      const binary = await realpath(options.binary);
      const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
      const launcher = request.execution === "direct" ? binary : await prepareSpecialistLauncher({ binary, workspaceRoot: root, privateRoot: root });
      const start = (args: string[]) => {
        request.signal.throwIfAborted();
        // Script-based CLIs use env shebangs; hosted runners and standard Node
        // installs place their interpreter in /usr/local/bin.
        const child = spawn(launcher, args, { cwd: root, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home,
          ...(this.kind === "acp" ? { SD_ACP_TOKEN: credential } : { ANTHROPIC_API_KEY: credential }) }, stdio: "pipe" });
        children.add(child); child.once("close", () => children.delete(child));
        return child;
      };
      if (this.kind === "acp") {
        const child = start(options.args ?? []);
        const rpc = new JsonLines(child);
        const abort = () => rpc.fail(new DOMException("Cancelled", "AbortError"));
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          const initialized = await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "sciencediscovery", version: "0.0.0" } });
          if (initialized?.protocolVersion !== 1) throw new CodexRuntimeError("Unsupported ACP protocol version");
          const session = await rpc.call("session/new", { cwd: root, mcpServers: [] });
          if (typeof session?.sessionId !== "string") throw new CodexRuntimeError("Invalid ACP session");
          result.runtimeSessionId = session.sessionId;
          launched = true;
          await sink({ type: "sandbox_probe", ok: true, mode: request.execution ?? "sandbox" });
          await sink({ type: "started", runtimeSessionId: session.sessionId });
          let configOptions = session.configOptions;
          const applied = new Map<string, string>();
          return await runPlatformDecisions(request, sink, async prompt => {
            for (const [category, value] of [["model", request.model], ["thought_level", request.reasoningEffort]]) {
              if (!value || applied.get(category!) === value) continue;
              const option = Array.isArray(configOptions) ? configOptions.find((option: any) => option.category === category) : undefined;
              const choices = option?.options?.flatMap((item: any) => item.options ?? [item]);
              if (!option || !choices?.some((item: any) => item.value === value)) throw new SpecialistUnavailableError("ACP agent does not offer the requested runtime setting");
              const changed = await rpc.call("session/set_config_option", { sessionId: session.sessionId, configId: option.id, value });
              configOptions = changed.configOptions;
              applied.set(category!, value);
            }
            let text = "";
            rpc.onNotification = message => {
              if (message.method !== "session/update" || message.params?.sessionId !== session.sessionId) return;
              const update = message.params.update;
              if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") text += update.content.text;
              if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") rpc.fail(new CodexRuntimeError("ACP attempted a disabled native tool"));
            };
            const result = await rpc.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
            if (result?.stopReason !== "end_turn") throw new CodexRuntimeError("ACP prompt did not complete");
            return text;
          }, result);
        } finally { request.signal.removeEventListener("abort", abort); }
      }
      return await runPlatformDecisions(request, sink, async prompt => {
        const child = start(["--bare", "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          "--json-schema", JSON.stringify(platformDecisionSchema), ...(request.model ? ["--model", request.model] : []), ...(request.reasoningEffort ? ["--effort", request.reasoningEffort === "minimal" ? "low" : request.reasoningEffort] : [])]);
        let output = "";
        child.stdout.setEncoding("utf8"); child.stderr.resume();
        await new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk: string) => { output += chunk; if (output.length > 200000) { child.kill("SIGTERM"); reject(new CodexRuntimeError("Oversized Claude output")); } });
          child.stdin.on("error", () => reject(new SpecialistUnavailableError("Claude input closed")));
          child.on("error", () => reject(new SpecialistUnavailableError("Claude launch failed")));
          child.on("close", code => code === 0 ? resolve() : reject(new SpecialistUnavailableError("Claude provider request failed")));
          child.stdin.end(prompt);
        });
        request.signal.throwIfAborted();
        let response: any;
        try { response = JSON.parse(output); } catch { throw new CodexRuntimeError("Invalid Claude response"); }
        if (response.is_error) throw new SpecialistUnavailableError("Claude provider request failed");
        if (!launched) { launched = true; await sink({ type: "sandbox_probe", ok: true, mode: request.execution ?? "sandbox" }); }
        result.runtimeSessionId = typeof response.session_id === "string" ? response.session_id : undefined;
        const input = response.usage?.input_tokens; const outputTokens = response.usage?.output_tokens;
        if (Number.isSafeInteger(input) && Number.isSafeInteger(outputTokens) && input >= 0 && outputTokens >= 0) {
          const previous = result.usage;
          result.usage = { inputTokens: (previous?.inputTokens ?? 0) + input, outputTokens: (previous?.outputTokens ?? 0) + outputTokens, totalTokens: (previous?.totalTokens ?? 0) + input + outputTokens };
        }
        await sink({ type: "started", runtimeSessionId: result.runtimeSessionId });
        return JSON.stringify(response.structured_output);
      }, result);
    } catch (error) {
      request.signal.throwIfAborted();
      if (!launched) await sink({ type: "sandbox_probe", ok: false, mode: request.execution ?? "sandbox" });
      if (error instanceof CodexRuntimeError && !error.message.includes(credential)) throw error;
      throw new SpecialistUnavailableError("Specialist transport unavailable; check server runtime configuration");
    } finally {
      request.signal.removeEventListener("abort", stop);
      stop();
      // Allow the launcher to reap its isolated process tree before deleting HOME.
      await Promise.all([...children].map(child => new Promise<void>(resolve => { child.once("close", resolve); setTimeout(resolve, 2000).unref(); })));
      await rm(root, { recursive: true, force: true });
    }
  }
}
export class ClaudeCodeSpecialistAdapter extends ProcessAdapter { readonly kind = "claude-code" as const; }
export class AcpSpecialistAdapter extends ProcessAdapter { readonly kind = "acp" as const; }
