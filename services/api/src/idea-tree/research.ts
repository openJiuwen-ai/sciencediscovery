import { randomUUID } from "node:crypto";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { RunTokenRegistry } from "../evolution/llm-proxy.js";

/** Only transport and credentials live here. Python owns research state and scheduling. */
export function createIdeaResearchClient(options: {
  url: string; token?: string; apiOrigin: string; store: SessionStore; tokens: RunTokenRegistry;
}) {
  const grants = new Map<string, { sessionId: string; token: string }>();
  const pending = new Set<string>();
  async function invoke(sessionId: string, operation: string, input: Record<string, unknown> = {}): Promise<any> {
    const session = operation === "list" || operation === "get" || operation === "defaults"
      ? options.store.getSession(sessionId) : options.store.assertSessionWritable(sessionId);
    if (!session) throw new Error("Session not found");
    let payload: Record<string, unknown> = { ...input, operation, projectId: session.projectId, sessionId };
    let issued: string | undefined;
    if (operation === "create" || operation === "continue") {
      if (operation === "create" && typeof input.content === "string") {
        const objective = input.content.replace(/^\/idea-tree(?:-team)?(?:\s+|$)/u, "").trim();
        if (!objective) throw new Error("请在 /idea-tree 后描述研究任务");
        payload = {...payload, objective};
        delete payload.content;
      }
      const previous: IdeaResearchView | undefined = operation === "continue"
        ? await invoke(sessionId, "get", { researchId: input.researchId }) : undefined;
      if (previous && !["paused", "interrupted"].includes(previous.research.status)) throw new Error("Research is not resumable");
      const modelId = previous?.research.modelId ?? options.store.resolveRuntimeSettings(sessionId).effective.modelId;
      const model = options.store.getModel(modelId);
      if (!model || !options.store.getModelApiToken(model.id)) throw new Error("Configure a model with an API token before starting research");
      if (model.apiProtocol === "anthropic-messages") throw new Error("Idea Tree requires an OpenAI-compatible model endpoint");
      const researchId = previous?.research.id ?? `research-${randomUUID()}`;
      options.tokens.revoke(researchId);
      const token = options.tokens.issue(researchId, sessionId, model.id);
      grants.set(researchId, { sessionId, token });
      issued = researchId;
      payload = { ...payload, researchId, modelId: model.id,
        ...(operation === "create" ? { settings: { ...options.store.getIdeaTreeSettings(), ...(input.settings as object ?? {}) } } : {}),
        llm: { token, url: `${options.apiOrigin}/internal/evolve-llm/${researchId}/v1/chat/completions` } };
    }
    try {
      const observedGrants = new Map(grants);
      const response = await fetch(`${options.url.replace(/\/$/, "")}/idea-tree/research/command`, {
        method: "POST", headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as any;
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      const views: IdeaResearchView[] = body.items ?? (body.research ? [body] : []);
      for (const view of views) {
        if (!["running", "pausing"].includes(view.research.status) && grants.has(view.research.id) && grants.get(view.research.id) === observedGrants.get(view.research.id)) {
          options.tokens.revoke(view.research.id);
          grants.delete(view.research.id);
        }
      }
      return body;
    } catch (error) {
      if (issued) { options.tokens.revoke(issued); grants.delete(issued); }
      throw error;
    }
  }
  // Retire credentials even when the user closes the page. No execution is scheduled here.
  const timer = setInterval(() => {
    for (const [researchId, { sessionId }] of grants) {
      if (!pending.has(sessionId)) void command(sessionId, "get", { researchId }).catch(() => undefined);
    }
  }, 5000);
  timer.unref();
  async function command(sessionId: string, operation: string, input: Record<string, unknown> = {}) {
    const mutation = !["get", "list", "defaults"].includes(operation);
    if (mutation && pending.has(sessionId)) throw new Error("Another research control request is in progress");
    if (mutation) pending.add(sessionId);
    try { return await invoke(sessionId, operation, input); }
    finally { if (mutation) pending.delete(sessionId); }
  }
  async function cleanup(projectId: string, sessionId: string) {
    const response = await fetch(`${options.url.replace(/\/$/, "")}/idea-tree/research/command`, {
      method: "POST", headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      body: JSON.stringify({operation: "delete", projectId, sessionId}), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Research cleanup failed: HTTP ${response.status}`);
    for (const [id, owner] of grants) if (owner.sessionId === sessionId) { options.tokens.revoke(id); grants.delete(id); }
  }
  return { command, cleanup, close() { clearInterval(timer); for (const id of grants.keys()) options.tokens.revoke(id); } };
}
