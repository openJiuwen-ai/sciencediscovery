import { randomUUID } from "node:crypto";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { RunTokenRegistry } from "../evolution/llm-proxy.js";

/**
 * How long a grant nobody is watching waits between the fallback reads that
 * retire it. A research with a stream listener is not read at all: its stream
 * carries the terminal frame, and the sweep below leaves it alone.
 */
const RETIRE_SWEEP_MS = 5000;

/** The research states a stream stays open for; anything else is terminal. */
function terminal(status: unknown): boolean {
  return typeof status === "string" && status !== "running" && status !== "pausing";
}

/** Only transport and credentials live here. Python owns research state and scheduling. */
export function createIdeaResearchClient(options: {
  url: string; token?: string; connection?: () => Promise<{ url: string; internalToken: string }>; apiOrigin: string; store: SessionStore; tokens: RunTokenRegistry;
}) {
  async function connection() {
    const result = options.connection ? await options.connection() : { url: options.url, internalToken: options.token };
    if (!result.url) throw new Error("Evolve is not initialized. Select Init Evolve.");
    return result;
  }
  const grants = new Map<string, { sessionId: string; token: string }>();
  const pending = new Set<string>();
  /** Research ids with at least one open event stream, and how many. */
  const watchers = new Map<string, number>();
  function retire(researchId: string) {
    options.tokens.revoke(researchId);
    grants.delete(researchId);
  }
  async function invoke(sessionId: string, operation: string, input: Record<string, unknown> = {}): Promise<any> {
    const target = await connection();
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
      // A spent token budget is terminal, not a resumable pause: the same ceiling would
      // stop the next run before it did any work, so continue must not start it.
      if (previous?.research.status === "budget_exhausted") {
        throw new Error("Research exhausted its token budget; increase the token limit and start a new research");
      }
      if (previous && !["paused", "interrupted"].includes(previous.research.status)) throw new Error("Research is not resumable");
      const modelId = previous?.research.modelId ?? options.store.resolveRuntimeSettings(sessionId).effective.modelId;
      const model = options.store.getModel(modelId);
      if (!model || !options.store.getModelApiToken(model.id)) throw new Error("Configure a model with an API token before starting research");
      const researchId = previous?.research.id ?? `research-${randomUUID()}`;
      options.tokens.revoke(researchId);
      const token = options.tokens.issue(researchId, sessionId, model.id);
      grants.set(researchId, { sessionId, token });
      issued = researchId;
      payload = { ...payload, researchId, modelId: model.id,
        // The Session's own parameters come first: this is where a research is
        // created, and the card promises the next research here uses them.
        ...(operation === "create" ? { settings: { ...options.store.resolveIdeaTreeSettings(sessionId), ...(input.settings as object ?? {}) } } : {}),
        llm: { token, url: `${options.apiOrigin}/internal/evolve-llm/${researchId}/v1/chat/completions` } };
    }
    try {
      const observedGrants = new Map(grants);
      const response = await fetch(`${target.url.replace(/\/$/, "")}/idea-tree/research/command`, {
        method: "POST", headers: { "content-type": "application/json", ...(target.internalToken ? { authorization: `Bearer ${target.internalToken}` } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as any;
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      const views: IdeaResearchView[] = body.items ?? (body.research ? [body] : []);
      for (const view of views) {
        if (terminal(view.research.status) && grants.has(view.research.id) && grants.get(view.research.id) === observedGrants.get(view.research.id)) retire(view.research.id);
      }
      return body;
    } catch (error) {
      if (issued) { options.tokens.revoke(issued); grants.delete(issued); }
      throw error;
    }
  }
  // Retire credentials even when the user closes the page. A grant is normally
  // retired by the stream's terminal frame or by a control answer that already
  // reports a terminal state; only a research with no stream listener — the page
  // was closed and the stream went with it — needs this fallback read, and then
  // one `get` per sweep is enough. No execution is scheduled here.
  const timer = setInterval(() => {
    for (const [researchId, { sessionId }] of grants) {
      if (watchers.has(researchId)) continue;
      if (!pending.has(sessionId)) void command(sessionId, "get", { researchId }).catch(() => undefined);
    }
  }, RETIRE_SWEEP_MS);
  timer.unref();
  async function command(sessionId: string, operation: string, input: Record<string, unknown> = {}) {
    const mutation = !["get", "list", "defaults"].includes(operation);
    if (mutation && pending.has(sessionId)) throw new Error("Another research control request is in progress");
    if (mutation) pending.add(sessionId);
    try { return await invoke(sessionId, operation, input); }
    finally { if (mutation) pending.delete(sessionId); }
  }
  async function cleanup(projectId: string, sessionId: string) {
    if (!options.url && !options.connection) return;
    const target = await connection();
    const response = await fetch(`${target.url.replace(/\/$/, "")}/idea-tree/research/command`, {
      method: "POST", headers: { "content-type": "application/json", ...(target.internalToken ? { authorization: `Bearer ${target.internalToken}` } : {}) },
      body: JSON.stringify({operation: "delete", projectId, sessionId}), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Research cleanup failed: HTTP ${response.status}`);
    for (const [id, owner] of grants) if (owner.sessionId === sessionId) retire(id);
  }
  /**
   * Watch one research's stream, and retire its grant on the terminal frame.
   *
   * The frames are the state a `get` would answer with, so a watched research
   * needs no read of its own. Leaving the stream does not retire the grant: the
   * research keeps running after the user closes the page, and the fallback sweep
   * is what retires it once it settles.
   *
   * A terminal frame belongs to the grant the stream was opened for. `continue`
   * issues a new grant for the same research id, and the frames of the stream
   * that was already open still describe the run that just ended — retiring on
   * one of those would kill the run the user just resumed. The token captured
   * here is the same generation check `invoke` makes of the grant it saw.
   */
  function follow(body: ReadableStream<Uint8Array>, researchId: string, signal: AbortSignal) {
    watchers.set(researchId, (watchers.get(researchId) ?? 0) + 1);
    const generation = grants.get(researchId)?.token;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      const remaining = (watchers.get(researchId) ?? 1) - 1;
      if (remaining > 0) watchers.set(researchId, remaining); else watchers.delete(researchId);
    };
    signal.addEventListener("abort", leave, { once: true });
    const settle = () => {
      // Nothing to retire when this stream has no grant of its own, and nothing to
      // retire when the research has been resumed since the stream was opened.
      if (generation === undefined || grants.get(researchId)?.token !== generation) return;
      retire(researchId);
    };
    const decoder = new TextDecoder();
    let buffered = "";
    const inspect = (chunk: Uint8Array) => {
      buffered += decoder.decode(chunk, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as { research?: { status?: string } };
            if (terminal(parsed.research?.status)) settle();
          } catch {
            // A frame we cannot read is not a terminal state.
          }
        }
      }
    };
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => { inspect(chunk); controller.enqueue(chunk); },
      // `cancel` as well as `flush`: a consumer that throws its reader away stops
      // the source without an abort signal, and the sweep has to start watching
      // that research again rather than stay quiet for a stream nobody reads.
      cancel: leave,
      flush: leave,
    }));
  }
  async function events(sessionId: string, researchId: string, signal: AbortSignal) {
    const target = await connection();
    const session = options.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const response = await fetch(`${target.url.replace(/\/$/, "")}/idea-tree/research/events`, {
      method: "POST", headers: { "content-type": "application/json", ...(target.internalToken ? { authorization: `Bearer ${target.internalToken}` } : {}) },
      body: JSON.stringify({operation: "get", projectId: session.projectId, sessionId, researchId}), signal,
    });
    if (!response.ok || !response.body) throw new Error(`Research stream failed: HTTP ${response.status}`);
    return follow(response.body, researchId, signal);
  }
  async function summary(sessionId: string, researchId?: string) {
    const view: IdeaResearchView | undefined = researchId
      ? await command(sessionId, "get", {researchId}) : (await command(sessionId, "list")).items[0];
    if (!view) return {message: "This session has no Idea Tree research yet."};
    return { ...view.research, candidates: view.graph.nodes.filter(n => n.kind === "candidate").map(n => ({
      id: n.id, hypothesis: n.hypothesis, status: n.status, score: n.score, insight: n.insight,
    })), insight: view.graph.nodes.find(n => n.id === "ROOT")?.insight };
  }
  return { command, cleanup, events, summary, close() { clearInterval(timer); for (const id of [...grants.keys()]) retire(id); } };
}
