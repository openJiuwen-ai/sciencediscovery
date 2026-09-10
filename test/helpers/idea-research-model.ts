import { createServer } from "node:http";

/** Only the provider is simulated. The API, Python engine and persistence are real. */
export async function ideaResearchModel() {
  const requests: Array<{ system: string; payload: any }> = [];
  let hold = true;
  let holdAssessments = false;
  const assessmentReleases: Array<() => void> = [];
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const system = body.messages[0].content as string;
    if (body.stream) {
      const hasTool = body.tools?.some((t: any) => t.function?.name === 'create_idea_research');
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user');
      const latestUserIndex = body.messages.lastIndexOf(lastUser);
      const handedOff = body.messages.slice(latestUserIndex + 1).some((m: any) => m.role === 'tool');
      const objective = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
      const action = hasTool && !handedOff;
      const delta = action ? {role: 'assistant', tool_calls: [{index: 0, id: 'create-research', type: 'function', function: {name: 'create_idea_research', arguments: JSON.stringify({objective, materials: 'User supplied: near-neutral water, recovery and leaching matter. Retrieval explicitly skipped for this demo.'})}}]} : {role: 'assistant', content: hasTool ? '已启动 Idea Tree 研究，请查看树卡片。' : 'Catalyst research'};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(`data: ${JSON.stringify({id:'lead', object:'chat.completion.chunk', choices:[{index:0, delta, finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id:'lead', object:'chat.completion.chunk', choices:[{index:0, delta:{}, finish_reason:action ? 'tool_calls' : 'stop'}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}})}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    // Session title generation is an ordinary non-streaming model call.
    let payload: any;
    try { payload = JSON.parse(body.messages[1].content); }
    catch { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Catalyst research'},finish_reason:'stop'}]})); return; }
    requests.push({ system, payload });
    if (hold && payload.hypothesis && !payload.candidate && !payload.children) {
      await new Promise<void>(resolve => { release = resolve; });
    }
    if (holdAssessments && payload.perspective) {
      await new Promise<void>(resolve => assessmentReleases.push(resolve));
    }
    let answer: object;
    if (payload.maximumCandidates) {
      answer = { candidates: [{ direction: `Direction ${payload.round % 2}`, refinements: Array.from({length: Math.max(0, payload.maxDepth - 2)}, (_, i) => `Refinement ${i + 1}`), hypothesis: `Candidate ${payload.round}: reduce metal leaching` }], reason: "Compare alternatives and improve prior weaknesses" };
    } else if (payload.perspective) {
      answer = { text: `${payload.perspective}: assess uncertainty`, score: 7 };
    } else if (payload.children) {
      answer = { text: "Shared insight: improve recovery and verify metal leaching." };
    } else if (payload.assessments) {
      answer = { text: "Candidate is promising; test leaching and recycling before experiments." };
    } else {
      answer = { text: "Fe/Mn catalyst on recyclable support; supplied evidence only." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    apiToken: "local-stub", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "idea-research-stub", requests,
    holdAssessments() { holdAssessments = true; },
    releaseAssessments() { holdAssessments = false; assessmentReleases.splice(0).forEach(release => release()); },
    holdDesign() { hold = true; release = undefined; },
    resume() { hold = false; release?.(); },
    async stop() { holdAssessments = false; assessmentReleases.splice(0).forEach(release => release()); hold = false; release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
