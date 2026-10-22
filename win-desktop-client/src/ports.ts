// Port-epoch resolution (F7.6 / 审查#9). The stack fixes its ports by default
// (UI 4310 / runner 4311 / API 4410 / evolve 4313 / memory-graph 17674) but
// start-stack.mjs already honours the SCIENCE_AGENT_*_PORT / _URL variables,
// so the shell can shift the whole stack by an "epoch" when the defaults are
// occupied. All decisions here are pure functions; the net probes are thin IO.

export interface StackPorts {
  epoch: number;
  publicPort: number;  // web UI (adapter)
  runnerPort: number;
  legacyPort: number;  // control API (health + Bearer)
  // F10.6q: memory-graph and evolve used to sit on FIXED ports outside the
  // epoch system — any stray listener on 17674 doomed the stack even when
  // every epoch port was free (field case 2026-10-19: an old instance's
  // memory-graph held 17674), and runner 4311+epoch would collide with
  // evolve's fixed 4313 from epoch 2 on. Both now shift with the epoch.
  memoryGraphPort: number;
  evolvePort: number;
}

export const MAX_PORT_EPOCH = 20;

export function portsForEpoch(epoch: number): StackPorts {
  return {
    epoch,
    publicPort: 4310 + epoch,
    runnerPort: 4311 + epoch,
    legacyPort: 4410 + epoch,
    memoryGraphPort: 17674 + epoch,
    evolvePort: 4313 + epoch,
  };
}

export function healthUrlForPorts(p: StackPorts): string {
  return `http://127.0.0.1:${p.legacyPort}/api/health`;
}

export function uiUrlForPorts(p: StackPorts): string {
  return `http://127.0.0.1:${p.publicPort}`;
}

/**
 * Env overrides for start-stack.mjs. Epoch 0 is the stack's own default, so
 * we pass nothing and keep the F2 contract byte-identical; a non-zero epoch
 * pins the full port set explicitly.
 */
export function stackEnvForPorts(p: StackPorts): NodeJS.ProcessEnv {
  if (p.epoch === 0) return {};
  return {
    SCIENCE_AGENT_PORT: String(p.publicPort),
    SCIENCE_AGENT_RUNNER_PORT: String(p.runnerPort),
    SCIENCE_AGENT_LEGACY_PORT: String(p.legacyPort),
    SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(p.memoryGraphPort),
    // The API's memory-graph client is URL-driven (bootstrap/config.ts), so
    // the shifted URL must travel with the shifted port.
    SCIENCE_AGENT_MEMORY_GRAPH_URL: `http://127.0.0.1:${p.memoryGraphPort}`,
    SCIENCE_AGENT_EVOLVE_PORT: String(p.evolvePort),
  };
}

/** Explicit epoch pinning for dev/diagnostics. Pure. */
export function epochFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env.SD_SHELL_PORT_EPOCH?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PORT_EPOCH) return null;
  return n;
}

/**
 * Find a stack that is already running on any epoch (previous shell launch
 * picked a non-default one). Refused connections reject immediately on
 * Windows, so scanning all epochs costs milliseconds.
 */
export async function probeHealthyEpoch(
  fetchImpl: typeof fetch,
  maxEpoch = MAX_PORT_EPOCH,
  timeoutMs = 800,
): Promise<number | null> {
  for (let epoch = 0; epoch <= maxEpoch; epoch++) {
    try {
      const res = await fetchImpl(healthUrlForPorts(portsForEpoch(epoch)), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return epoch;
    } catch {
      /* not listening on this epoch */
    }
  }
  return null;
}

/** First epoch whose full port set is free. Pure decision, injected probe. */
export async function firstFreeEpoch(
  isPortFree: (port: number) => boolean | Promise<boolean>,
  maxEpoch = MAX_PORT_EPOCH,
): Promise<number | null> {
  for (let epoch = 0; epoch <= maxEpoch; epoch += 1) {
    const p = portsForEpoch(epoch);
    const free = await Promise.all([
      isPortFree(p.publicPort),
      isPortFree(p.runnerPort),
      isPortFree(p.legacyPort),
      isPortFree(p.memoryGraphPort),
      isPortFree(p.evolvePort),
    ]);
    if (free.every(Boolean)) return epoch;
  }
  return null;
}
