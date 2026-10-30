// System proxy inheritance. Node (the stack, plugin
// downloads, model connectivity) does not read the Windows system proxy, so
// the shell mirrors the IE/system settings into HTTP(S)_PROXY for the stack
// child process — with an explicit NO_PROXY for loopback so the local stack
// traffic always stays direct. Parsing is pure and unit-tested; the registry
// read is one reg query.

export interface SystemProxySettings {
  enabled: boolean;
  server: string;
}

/** Parse one value out of `reg query` stdout. Pure. */
export function parseRegQueryValue(output: string, valueName: string): string | null {
  // Lines look like: `    ProxyEnable    REG_DWORD    0x1`
  for (const line of output.split(/\r?\n/)) {
    const m = line.trim().match(new RegExp(`^${valueName}\\s+\\S+\\s+(.+)$`));
    if (m) return m[1].trim();
  }
  return null;
}

/** Accepts "0x1"/"1"/"0x0"/"0". Pure. */
export function parseRegDword(raw: string | null): boolean {
  if (!raw) return false;
  const n = raw.toLowerCase().startsWith("0x") ? parseInt(raw, 16) : Number(raw);
  return n === 1;
}

/**
 * Map system proxy settings to env vars for the stack child.
 * Returns null when the system proxy is off or unusable (then the child
 * inherits whatever the shell itself got — unchanged default behaviour).
 *
 * ProxyServer registry forms handled:
 *   "proxy:8080"                          → http + https
 *   "http=proxy:8080;https=proxy:8080"   → per-scheme
 *   "socks=127.0.0.1:7890"               → not mirrored (Node stacks here
 *                                            don't speak socks in v1; better
 *                                            direct than half-broken)
 */
export function proxyEnvFromSystem(settings: SystemProxySettings | null): NodeJS.ProcessEnv | null {
  if (!settings || !settings.enabled) return null;
  const entries = settings.server.split(";").map(s => s.trim()).filter(Boolean);
  let http: string | null = null;
  let https: string | null = null;
  let bare: string | null = null;
  for (const entry of entries) {
    const [scheme, rest] = entry.includes("=") ? entry.split("=", 2) : ["", entry];
    switch (scheme.toLowerCase()) {
      case "http": http = rest.trim(); break;
      case "https": https = rest.trim(); break;
      case "socks": break; // v1: not mirrored — direct beats half-broken
      case "": bare = rest.trim(); break;
      default: break;
    }
  }
  const server = http ?? https ?? bare;
  if (!server) return null;
  const env: NodeJS.ProcessEnv = {
    HTTP_PROXY: `http://${server}`,
    HTTPS_PROXY: `http://${https ?? server}`,
    // The whole local stack talks 127.0.0.1 — never route it through the proxy.
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  return env;
}
