// Wait for the adapter to report JiuwenSwarm is reachable before letting the
// user into the main UI. The adapter's /agent/info endpoint returns 200 once
// it can talk to JiuwenSwarm's management websocket; until then, chat will
// fail with "gateway unreachable".

export interface AgentInfo {
  jiuwenswarm?: {
    reachable?: boolean;
  };
}

export async function waitForAgentReady(
  agentInfoUrl: string,
  token: string | null,
  budgetMs: number,
  onAttempt?: (attempt: number) => void,
): Promise<boolean> {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < budgetMs) {
    attempt += 1;
    try {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(agentInfoUrl, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as AgentInfo;
        if (body.jiuwenswarm?.reachable) {
          return true;
        }
      }
    } catch {
      // Adapter is up but /agent/info not ready yet, or JiuwenSwarm is still
      // starting. Keep polling.
    }
    onAttempt?.(attempt);
    // Simple 1-second backoff to avoid hammering the adapter while it waits for
    // JiuwenSwarm to come up.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
