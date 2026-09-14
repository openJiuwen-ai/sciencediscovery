import { createServer } from "node:http";

/** A local model fixture whose tool arguments use actual Python tool results. */
export async function ideaTreeModel(options: { pauseDesign?: boolean } = {}) {
  let pauseDesign = options.pauseDesign ?? false;
  let generation = 0;
  let step = 0;
  let treeId = "";
  let revision = 1;
  let execution: Record<string, any> = {};
  let handle = "";
  let childDigest = "";
  const requests: Array<{ main: boolean; system: string; messages: unknown[] }> = [];
  const errors: string[] = [];
  const candidate = "candidate-A: Fe-N-C catalyst";
  const mutate = (params: object) => ({ tree_id: treeId, expected_revision: revision, idempotency_key: `journey-${generation}-${step}`, ...params });
  const delegate = (role: string, prompt: string) => ({ tool: "task", args: {
    description: `Idea Tree ${role}`, prompt, specialistId: `builtin-${role}`,
    subagent_type: "general-purpose", timeout_seconds: 60,
  } });
  let steps = [
    () => ({ tool: "tree_create", args: { idempotency_key: "journey-create", max_depth: 2, max_nodes: 8, max_search_rounds: 2, objective: "Compare catalyst hypotheses", root_hypothesis: "Catalyst research" } }),
    () => ({ tool: "tree_add_node", args: mutate({ parent_id: "ROOT", hypothesis: "Metal direction" }) }),
    () => ({ tool: "tree_add_node", args: mutate({ parent_id: "1", hypothesis: candidate }) }),
    () => ({ tool: "tree_claim", args: mutate({ node_id: "1.1" }) }),
    () => delegate("creative-material-design", `Design one candidate: ${candidate}`),
    ...["activity", "stability", "sustainability"].map(dimension => () => delegate("assessment-screener", `Evaluate ${dimension} independently. Immutable candidate: ${candidate}`)),
    () => delegate("insight-aggregator", `Aggregate activity=8, stability=7, sustainability=6 for ${candidate}. State the weights and reusable insight.`),
    () => ({ tool: "idea_tree_finalize", args: { tree_id: treeId, execution_id: execution.executionId, attempt: execution.attempt, request_hash: execution.requestHash, score: 7.05, insight: "Stable catalyst; improve activity next.", artifacts: [] } }),
    () => ({ tool: "tree_complete", args: mutate({ result_handle: handle }) }),
    () => ({ tool: "tree_view", args: { tree_id: treeId, format: "node", node_id: "1" } }),
    () => ({ tool: "tree_update_node", args: mutate({ node_id: "1", insight: "Direction insight: stability retained, activity remains uncertain.", propagation_child_digest: childDigest }) }),
    () => ({ tool: "tree_view", args: { tree_id: treeId, format: "node", node_id: "ROOT" } }),
    () => ({ tool: "tree_update_node", args: mutate({ node_id: "ROOT", insight: "ROOT insight: compare activity while preserving stability.", propagation_child_digest: childDigest }) }),
    () => ({ tool: "tree_finish", args: mutate({}) }),
  ];
  function observe(value: any) {
    if (typeof value === "string") { try { observe(JSON.parse(value)); } catch {} return; }
    if (!value || typeof value !== "object") return;
    if (value.treeId) treeId = value.treeId;
    if (typeof value.revision === "number") revision = value.revision;
    if (value.request?.executionId) execution = value.request;
    if (value.result_handle) handle = value.result_handle;
    if (value.propagation?.childDigest) childDigest = value.propagation.childDigest;
    if (Array.isArray(value)) for (const entry of value) observe(entry);
    else if (value.text) observe(value.text);
    else if (value.content) observe(value.content);
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const main = Boolean(body.tools?.some((t: any) => t.function?.name === "tree_create"));
        const system = body.messages?.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n") ?? "";
        if (body.tools?.length) requests.push({ main, system, messages: body.messages });
        if (main) for (const message of body.messages ?? []) if (message.role === "tool") observe(message.content);
        if (!main && body.tools?.length && pauseDesign) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          return; // Remains in flight until the user cancels the actual Subagent.
        }
        const action = main ? steps[step]?.() : undefined;
        let content = body.tools?.length ? "Idea Tree completed with propagated ROOT insight." : "Catalyst journey";
        if (!main && body.tools?.length) {
          const input = JSON.stringify(body.messages);
          content = input.includes("Immutable candidate") ? JSON.stringify({ candidate, score: input.includes("Evaluate activity") ? 8 : input.includes("Evaluate stability") ? 7 : 6 }) : JSON.stringify({ candidate, score: 7.05, insight: "Stable catalyst; improve activity next." });
        }
        const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `idea-call-${++step}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args) } }] } : { role: "assistant", content };
        const chunk = (d: object, finish: string | null) => ({ id: `idea-${step}`, object: "chat.completion.chunk", created: 1, model: "idea-tree-fixture", choices: [{ index: 0, delta: d, finish_reason: finish }] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
        res.write(`data: ${JSON.stringify({ ...chunk({}, action ? "tool_calls" : "stop"), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(String(error)); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "idea-tree-fixture", apiToken: "local-fixture",
    requests, errors,
    resume() {
      pauseDesign = false;
      generation += 1;
      const executeAndComplete = steps.slice(4);
      steps = [
        () => ({ tool: "tree_view", args: { tree_id: treeId, format: "full" } }),
        () => ({ tool: "tree_retry", args: mutate({ node_id: "1.1" }) }),
        () => ({ tool: "tree_claim", args: mutate({ node_id: "1.1" }) }),
        ...executeAndComplete,
      ];
      step = 0;
    },
    get treeId() { return treeId; }, stop: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
