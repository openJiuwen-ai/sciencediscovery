import type { IdeaTreeGraph, IdeaTreeState, IdeaTreeSettings } from "@sciencediscovery/schema";
import type { IdeaTreeCommandContext, IdeaTreePersistence } from "./persistence.js";
import { IdeaTreePersistenceError } from "./persistence.js";
import { IdeaTreeRuntimeError } from "./runtime.js";
import type { AgentTool } from "@sciencediscovery/tools";
import type { TSchema } from "typebox";

export interface IdeaTreeServiceOptions { url: string; token?: string }

/** Shared transport for the standalone service. No tree transitions live in Node. */
export class IdeaTreeServiceClient {
  constructor(private readonly options: IdeaTreeServiceOptions) {}

  async tools(call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<AgentTool[]> {
    const {tools} = await this.json<{tools: Array<{name: string; description: string; inputSchema: TSchema}>}>("/mcp/tools");
    return tools.map(tool => ({name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
      execute: async (_id, args) => {
        const result = await call(tool.name, args as Record<string, unknown>);
        return {content: [{type: "text" as const, text: JSON.stringify(result)}], details: result};
      },
    }));
  }

  async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.options.url.replace(/\/$/, "")}${path}`, {
        method, headers: { "content-type": "application/json", ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new IdeaTreePersistenceError("PERSISTENCE_UNAVAILABLE", `Idea Tree service is unavailable: ${String(error)}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string | {code?: string; message?: string} };
      const detail = body.detail;
      throw new IdeaTreeRuntimeError(typeof detail === "object" ? detail.code ?? "STORAGE_ERROR" : "STORAGE_ERROR",
        typeof detail === "string" ? detail : detail?.message ?? `Idea Tree HTTP ${response.status}`);
    }
    return response;
  }

  async json<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
    return await (await this.request(path, method, body)).json() as T;
  }

  async settings(seed: IdeaTreeSettings, update?: unknown): Promise<IdeaTreeSettings> {
    const imported = await this.json<IdeaTreeSettings>("/settings/import", "POST", seed);
    return update === undefined ? imported : this.json("/api/settings/idea-tree", "PUT", update);
  }

  /** The API binds identity and model access; agents see only the MCP tool schema. */
  async research(payload: Record<string, unknown>): Promise<any> {
    const operation = String(payload.operation);
    if (!["create", "get", "list", "pause", "continue", "end"].includes(operation)) {
      return this.json("/idea-tree/research/command", "POST", payload);
    }
    const {token} = await this.json<{token: string}>("/mcp/scopes", "POST", {
      projectId: payload.projectId, sessionId: payload.sessionId,
      researchId: payload.researchId ?? "", modelId: payload.modelId ?? "",
      llm: payload.llm ?? {}, settings: payload.settings ?? {},
    });
    try {
      const name = operation === "create" ? "create_idea_research"
        : ["get", "list"].includes(operation) ? "get_idea_research" : "control_idea_research";
      const args = operation === "create" ? {objective: payload.objective, materials: payload.materials ?? ""}
        : operation === "list" ? {} : {researchId: payload.researchId, ...(["get"].includes(operation) ? {} : {operation})};
      const result = await this.json<{result?: {isError?: boolean; content: Array<{text: string}>}; error?: {message: string}}>(`/mcp/${token}`, "POST", {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args},
      });
      if (result.error || !result.result) throw new Error(result.error?.message ?? "Missing MCP result");
      const text = result.result.content.map(item => item.text).join("\n");
      if (result.result.isError) throw new Error(text);
      return JSON.parse(text);
    } finally {
      await this.request(`/mcp/${token}`, "DELETE").catch(() => undefined);
    }
  }

  /** Compatibility reads for persisted pre-autonomous trees, not agent tools. */
  repository(scope: { projectId: string; sessionId: string }): IdeaTreePersistence {
    const call = async <T>(operation: string, params: object, context: IdeaTreeCommandContext = {}): Promise<T> => {
      const body = await this.json<{result: T}>("/idea-tree/command", "POST", { ...context, ...scope, operation, params });
      return body.result;
    };
    return { key: `idea-tree:${scope.projectId}:${scope.sessionId}`, call,
      deleteAll: () => call<void>("deleteAll", {}), listTreeIds: () => call<string[]>("listTreeIds", {}),
      readTree: treeId => call<IdeaTreeState | null>("readTree", {treeId}),
      readGraph: treeId => call<IdeaTreeGraph | null>("readGraph", {treeId}),
    };
  }
}
