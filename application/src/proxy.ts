// System proxy inheritance. Node (the stack, plugin
// downloads, model connectivity) does not read the OS system proxy, so
// the shell mirrors the system settings into HTTP(S)_PROXY for the stack
// child process — with an explicit NO_PROXY for loopback so the local stack
// traffic always stays direct. Parsing is pure and unit-tested; the OS read
// is one command (reg query on win32, scutil --proxy on darwin).

export interface SystemProxySettings {
  enabled: boolean;
  server: string;
  /** macOS ExceptionsList — hosts that must stay direct (win32 reg path never sets it). */
  exceptions?: string[];
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

// --- macOS: scutil --proxy ------------------------------------------------------

/**
 * One `key : value` line out of `scutil --proxy` stdout, or null. Pure.
 * Lines look like `  HTTPEnable : 1` (exact " : " separator, key no spaces).
 */
export function parseScutilValue(output: string, key: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
    if (m && m[1] === key) {
      const value = m[2].trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/**
 * Parse `scutil --proxy` stdout into SystemProxySettings. Pure.
 *
 * Output shape (keys always present, values may be empty when off):
 *   HTTPEnable : 1
 *   HTTPProxy : 127.0.0.1
 *   HTTPPort : 7890
 *   HTTPSEnable : 1
 *   HTTPSProxy : 127.0.0.1
 *   HTTPSPort : 7890
 *   SOCKSEnable : 0
 *   SOCKSProxy : 127.0.0.1
 *   SOCKSPort : 7890
 *   ExceptionsList : "localhost", "127.0.0.1", "*.local", "169.254/16"
 *
 * The result reuses the win32 per-scheme server syntax
 * ("http=h:p;https=h:p;socks=h:p") so proxyEnvFromSystem — including its
 * socks-not-mirrored and bare-host fallback decisions — is shared verbatim
 * on both platforms; only the OS read differs. PAC/autoproxy (ProxyAuto*
 * keys) is deliberately not collected: v1 mirrors static HTTP(S) proxies
 * only (same "direct beats half-broken" call as socks-only on win32).
 */
export function parseScutilProxy(output: string): SystemProxySettings | null {
  const enabled = (key: string): boolean => parseScutilValue(output, key) === "1";
  const hostPort = (prefix: string): string | null => {
    if (!enabled(`${prefix}Enable`)) return null;
    const host = parseScutilValue(output, `${prefix}Proxy`);
    const port = parseScutilValue(output, `${prefix}Port`);
    if (!host || !port) return null;
    return `${host}:${port}`;
  };
  const entries: string[] = [];
  const http = hostPort("HTTP");
  if (http) entries.push(`http=${http}`);
  const https = hostPort("HTTPS");
  if (https) entries.push(`https=${https}`);
  // SOCKS: collected for the server string (proxyEnvFromSystem's
  // socks-not-mirrored decision then applies), never alone as the winner:
  // a socks-only config must yield null, not a bogus "server".
  const socks = hostPort("SOCKS");
  if (socks) entries.push(`socks=${socks}`);
  if (!http && !https) return null; // socks-only / PAC / proxy off → not mirrored
  const settings: SystemProxySettings = { enabled: true, server: entries.join(";") };
  const rawExceptions = parseScutilValue(output, "ExceptionsList");
  if (rawExceptions) {
    const exceptions = rawExceptions.split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (exceptions.length) settings.exceptions = exceptions;
  }
  return settings;
}

/**
 * Map system proxy settings to env vars for the stack child.
 * Returns null when the system proxy is off or unusable (then the child
 * inherits whatever the shell itself got — unchanged default behaviour).
 *
 * ProxyServer registry forms handled:
 *   "proxy:8080"                          → http + https
 *   "http=proxy:8080;https=proxy:8080"   → per-scheme
 *   "socks=127.0.0.1:7890"               → ALL_PROXY=socks5://… (the stack's
 *                                            consumers — undici ProxyAgent and
 *                                            httpx[socks] — both speak SOCKS5,
 *                                            so mirroring is no longer
 *                                            half-broken; kept out of
 *                                            HTTP(S)_PROXY so per-scheme
 *                                            entries still win where present)
 */
export function proxyEnvFromSystem(settings: SystemProxySettings | null): NodeJS.ProcessEnv | null {
  if (!settings || !settings.enabled) return null;
  const entries = settings.server.split(";").map(s => s.trim()).filter(Boolean);
  let http: string | null = null;
  let https: string | null = null;
  let bare: string | null = null;
  let socks: string | null = null;
  for (const entry of entries) {
    const [scheme, rest] = entry.includes("=") ? entry.split("=", 2) : ["", entry];
    switch (scheme.toLowerCase()) {
      case "http": http = rest.trim(); break;
      case "https": https = rest.trim(); break;
      case "socks": socks = rest.trim(); break;
      case "": bare = rest.trim(); break;
      default: break;
    }
  }
  const server = http ?? https ?? bare;
  // Upstream (2e9feb09 "take over proxy configuration") added socks support
  // and the ::1 loopback entry; the darwin side (B1-2) additionally folds the
  // macOS ExceptionsList (bypass hosts) into NO_PROXY — a host the OS keeps
  // direct must stay direct for the stack too. Both semantics survive here.
  if (!server && !socks) return null;
  const env: NodeJS.ProcessEnv = {};
  if (server) {
    env.HTTP_PROXY = `http://${server}`;
    env.HTTPS_PROXY = `http://${https ?? server}`;
  }
  if (socks) {
    env.ALL_PROXY = `socks5://${socks}`;
    env.all_proxy = `socks5://${socks}`;
  }
  // The whole local stack talks 127.0.0.1 and ::1 — never route loopback
  // through the proxy. Mirrors proxyProcessEnvironment's bypass list. The
  // macOS ExceptionsList (bypass hosts) joins it (win32 reg path never sets
  // exceptions — undefined spreads to nothing).
  const noProxy = ["localhost,127.0.0.1,::1", ...(settings.exceptions ?? [])].join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}
