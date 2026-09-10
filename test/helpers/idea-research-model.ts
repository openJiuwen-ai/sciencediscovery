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
    const payload = JSON.parse(body.messages[1].content);
    requests.push({ system, payload });
    if (hold && payload.hypothesis && !payload.candidate && !payload.children) {
      await new Promise<void>(resolve => { release = resolve; });
    }
    if (holdAssessments && payload.perspective) {
      await new Promise<void>(resolve => assessmentReleases.push(resolve));
    }
    let answer: object;
    if (payload.maximumCandidates) {
      answer = { candidates: [{ direction: `Direction ${payload.round % 2}`, hypothesis: `Candidate ${payload.round}: reduce metal leaching` }], reason: "Compare alternatives and improve prior weaknesses" };
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
