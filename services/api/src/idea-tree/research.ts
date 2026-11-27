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

/**
 * How long the engine is given to acknowledge a command.
 *
 * The engine starts the run before it answers (`research_service.start()` saves
 * `running` and schedules the task, then returns), so this timeout says nothing
 * about whether the command took effect — only that its answer is not coming.
 */
const COMMAND_TIMEOUT_MS = 15_000;

/** How long the read-back gets when it has to decide a lost answer's fate. */
const RECOVERY_READ_MS = 5_000;

/** A refusal the engine itself answered: it did not start anything. */
class CommandRefused extends Error {
  /** The status it answered with. A 404 is how it says it knows no such research. */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The research states a stream stays open for; anything else is terminal. */
function terminal(status: unknown): boolean {
  return typeof status === "string" && status !== "running" && status !== "pausing";
}

/**
 * Whether a read-back shows a resume took effect even though the research comes
 * back in the state the command found.
 *
 * `continue` on an interrupted research can start a run that dies again on the
 * same cause: the name is unchanged, but the attempt left a mark — another
 * round, another round's usage, the engine's own reason for stopping, or the
 * activity it appends for each model call before making it. The last one
 * matters on its own: a call that fails the same way again moves neither the
 * round, nor the usage the provider never reported, nor the reason's text, so
 * only the new activity says a call was made. With none of them moved, nothing
 * ran.
 */
function movedPast(previous: IdeaResearchView["research"] | undefined, next: IdeaResearchView["research"]): boolean {
  if (!previous) return false;
  return next.round !== previous.round
    || next.tokens !== previous.tokens
    || next.reason !== previous.reason
    || (next.activities?.length ?? 0) > (previous.activities?.length ?? 0);
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
  /** Give back the grant a command issued, if it issued one. */
  function withdraw(issued: string | undefined) {
    if (!issued) return;
    options.tokens.revoke(issued);
    grants.delete(issued);
  }
  /**
   * What the research is doing now, and whether the engine answered at all.
   *
   * A refusal from the engine (`CommandRefused`) means it heard the question, so
   * a research it does not know is a research that does not exist. Any other
   * failure means the question itself was lost, and nothing can be concluded.
   */
  async function readBack(sessionId: string, researchId: string): Promise<{ reached: boolean; view?: IdeaResearchView }> {
    try {
      return { reached: true, view: await invoke(sessionId, "get", { researchId }, RECOVERY_READ_MS) };
    } catch (error) {
      return { reached: error instanceof CommandRefused };
    }
  }
  async function invoke(sessionId: string, operation: string, input: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<any> {
    const target = await connection();
    const session = operation === "list" || operation === "get" || operation === "defaults"
      ? options.store.getSession(sessionId) : options.store.assertSessionWritable(sessionId);
    if (!session) throw new Error("Session not found");
    let payload: Record<string, unknown> = { ...input, operation, projectId: session.projectId, sessionId };
    let issued: string | undefined;
    /** The status a `continue` found before sending, so a read-back can tell a
     *  run that started from a research that never left where it was. */
    let before: string | undefined;
    /** That same view: a resumed run can end where it started and still have run,
     *  which the state's name alone cannot show. */
    let beforeState: IdeaResearchView["research"] | undefined;
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
      before = previous?.research.status;
      beforeState = previous?.research;
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
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      });
      // A refusal is judged by the status, not by the body. A gateway's HTML page
      // is still an answer, and asking it to be JSON first would rethrow a parse
      // error instead of the status that was actually given.
      let body: any;
      try { body = await response.json(); } catch { body = undefined; }
      if (!response.ok) {
        const detail = body === undefined ? undefined
          : typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail);
        const message = detail || `HTTP ${response.status}`;
        // The engine's own answer is a verdict: it replied, so nothing started.
        // A 5xx is not a verdict. The engine saves `running` and schedules the run
        // before it builds its answer, so an error while producing that answer
        // arrives with the run already going — the same case as a lost answer, and
        // it takes the read-back below.
        if (response.status < 500) throw new CommandRefused(message, response.status);
        throw new Error(message);
      }
      if (body === undefined) throw new Error(`The answer to the ${operation} command could not be read.`);
      const views: IdeaResearchView[] = body.items ?? (body.research ? [body] : []);
      for (const view of views) {
        if (terminal(view.research.status) && grants.has(view.research.id) && grants.get(view.research.id) === observedGrants.get(view.research.id)) retire(view.research.id);
      }
      return body;
    } catch (error) {
      if (!issued) throw error;
      // A lost answer is not a failed command. The engine saves `running` and
      // schedules the run before it replies, so a timeout — or a reply that never
      // arrives — says nothing about whether the research is already working.
      // Revoking here would leave a running research with no credential: the LLM
      // proxy answers 401 to every model call, and the run the user did start dies
      // for a reason nobody can see. Only an answered refusal is certain.
      if (error instanceof CommandRefused) {
        withdraw(issued);
        throw error;
      }
      const known = await readBack(sessionId, issued);
      if (known.view) {
        const status = known.view.research.status;
        if (status === "running" || status === "pausing") {
          // The command took effect. The grant stays, and the caller is handed the
          // state the engine reports instead of an error about a lost answer.
          return known.view;
        }
        if (operation === "create" || status !== before || movedPast(beforeState, known.view.research)) {
          // It took effect and has already ended — a research the engine knows,
          // in a state that is not where this command found the research, or in
          // that same state carrying the mark of a run that started and stopped
          // again. Retire the grant and report the view: telling the caller it
          // failed would invite a retry, and a retried create makes a second one.
          retire(issued);
          return known.view;
        }
        // The engine answered and the research is exactly where it was: nothing
        // took effect, so the grant it was issued goes back.
        withdraw(issued);
        throw error;
      }
      if (!known.reached) {
        // Nothing answered, so nothing is known. Keep the grant: a run that did
        // start must not be left without a credential. The fallback sweep retires
        // it as soon as the research reports a terminal state — or, if the
        // research never existed, as soon as the engine says it knows no such
        // research.
        throw new Error(`The research command was sent but its answer was lost, and ${issued} could not be read back. Its credential was kept, so a run that started is not left without one.`);
      }
      // The engine answered a question about a research it does not know — a 404 —
      // so the command never took effect and the grant it was issued goes back.
      withdraw(issued);
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
      // A Session record that no longer exists is terminal: the research it owned
      // will never be read again, and `invoke` refuses such a Session before
      // reaching the engine (`Session not found`), so waiting for an answer that
      // cannot come would keep the credential and cost one read per sweep.
      if (!options.store.getSession(sessionId)) { retire(researchId); continue; }
      if (pending.has(sessionId)) continue;
      void command(sessionId, "get", { researchId }).catch((error: unknown) => {
        // A research the engine does not know was never created: the command and
        // its read-back both failed before it existed. No terminal state is ever
        // coming for it, so this 404 is the only chance to release the grant —
        // otherwise it is read every five seconds until `close()`.
        if (error instanceof CommandRefused && error.status === 404) retire(researchId);
      });
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
  function retireSession(sessionId: string) {
    for (const [id, owner] of grants) if (owner.sessionId === sessionId) retire(id);
  }
  /**
   * Retire a deleted Session's grants, then ask the engine to forget its research.
   *
   * The grants are this process's own state, so the revoke happens before the
   * engine call: a transport error, a timeout or a non-2xx answer must not leave a
   * deleted Session's credential resolvable. The failure is still thrown, because
   * the engine-side cleanup did not happen.
   */
  async function cleanup(projectId: string, sessionId: string) {
    retireSession(sessionId);
    if (!options.url && !options.connection) return;
    const target = await connection();
    const response = await fetch(`${target.url.replace(/\/$/, "")}/idea-tree/research/command`, {
      method: "POST", headers: { "content-type": "application/json", ...(target.internalToken ? { authorization: `Bearer ${target.internalToken}` } : {}) },
      body: JSON.stringify({operation: "delete", projectId, sessionId}), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Research cleanup failed: HTTP ${response.status}`);
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
