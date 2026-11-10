// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Source-loadable transport for installation scripts and built services alike.
import { isIP } from 'node:net';

export const proxyVariables = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
export function isLoopback(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || (isIP(host) === 4 && host.startsWith('127.'))
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]+$/.test(host);
}

export function bypassesProxy(url, entries = '') {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return entries.split(/[,\s]+/).some(entry => {
    if (entry === '*') return true;
    if (!entry) return false;
    const match = entry.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    const name = (match?.[1] ?? entry).replace(/^\[|\]$/g, '').replace(/^\*?\./, '').toLowerCase();
    return (!match || match[2] === port) && (host === name || host.endsWith(`.${name}`));
  });
}

function value(env, key) { return (env[key] ?? env[key.toUpperCase()])?.trim(); }
export function validateProxyUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid proxy URL (value omitted)'); }
  // A proxy URL names where to connect, nothing else: a path or query would be
  // silently dropped by every consumer, so refusing it is the honest answer.
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.hash || parsed.search || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('Proxy URL must use HTTP, HTTPS or SOCKS5 and name only host and port (value omitted)');
  }
  return url;
}

export function resolveRoute(target, policy = { mode: 'environment' }, env = process.env) {
  if (!policy || !['direct', 'environment', 'url'].includes(policy.mode)) throw new Error('Invalid proxy mode (value omitted)');
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) targets are supported');
  // An explicit proxy that cannot name an address is a configuration error, not
  // permission to go direct: silently unwrapping would leak the request.
  if (policy.mode === 'url' && !policy.url) throw new Error('Proxy policy selects a url without one (value omitted)');
  if (isLoopback(url) || policy.mode === 'direct') return { mode: 'direct' };
  if (bypassesProxy(url, policy.noProxy ?? value(env, 'no_proxy'))) return { mode: 'direct' };
  const candidate = policy.mode === 'url' ? policy.url
    : value(env, url.protocol === 'https:' ? 'https_proxy' : 'http_proxy') || value(env, 'all_proxy');
  return candidate ? { mode: 'url', url: validateProxyUrl(candidate) } : { mode: 'direct' };
}

export function proxyProcessEnvironment(policy = { mode: 'environment' }, base = process.env) {
  if (!policy || !['direct', 'environment', 'url'].includes(policy.mode)) throw new Error('Invalid proxy mode');
  if (policy.noProxy !== undefined && (typeof policy.noProxy !== 'string' || policy.noProxy.length > 4000)) throw new Error('Invalid proxy bypass list');
  const env = { ...base };
  for (const name of proxyVariables) delete env[name];
  if (policy.mode === 'direct') return env;
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy']) {
    const candidate = policy.mode === 'url' ? validateProxyUrl(policy.url) : value(base, name);
    if (!candidate) continue;
    const validated = validateProxyUrl(candidate);
    // pip/conda (requests-based children) reject a SOCKS scheme in
    // http_proxy/https_proxy and only understand SOCKS through all_proxy,
    // which needs PySocks. The managed starter environment declares it
    // (STARTER_PACKAGE_SPECS), and the runner installs it into task
    // environments cloned before that contract existed before pip runs.
    // micromamba is curl-based and parses the scheme either way, so leaving
    // http_proxy/https_proxy unset for SOCKS policies keeps pip/conda working
    // directly while curl still finds all_proxy.
    if (name !== 'all_proxy' && validated.startsWith('socks5:')) continue;
    env[name] = env[name.toUpperCase()] = validated;
  }
  // Consumers match NO_PROXY entries against a bare hostname, so the bracketed
  // IPv6 form would never match `::1`. Deduplicate: a base environment that
  // already lists the loopback entries (e.g. the Windows shell's mirror) must
  // not produce "localhost,127.0.0.1,localhost,127.0.0.1,::1".
  const bypass = [...new Set(
    (policy.noProxy ?? value(base, 'no_proxy') ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
      .concat(['localhost', '127.0.0.1', '::1']),
  )].join(',');
  env.no_proxy = env.NO_PROXY = bypass;
  return env;
}

export function redactNetworkError(error) {
  const codes = [];
  const messages = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    const code = current.code || current.name;
    if (code && code !== 'Error' && !codes.includes(code)) codes.push(code);
    const message = String(current.message ?? current).replace(/(?:https?|socks5):\/\/[^\s"'<>]+/gi, '[network URL omitted]');
    if (!messages.includes(message)) messages.push(message);
  }
  const message = messages.join(': ') || 'Network request failed';
  return `${message}${codes.length ? ` (${codes.join(' / ')})` : ''}`;
}

// Scope dispatchers to one operation. Downloads fully consume the body before close.
export async function withProxyFetch(policy, action, env = process.env) {
  // The module is source-loadable (Docker build stages run the downloader with
  // no node_modules), so undici is optional: Node's global fetch already serves
  // direct routes identically, and only proxy routing needs ProxyAgent. A proxy
  // route without undici fails loudly instead of silently going direct.
  let undici = null;
  try { undici = await import('undici'); } catch { /* direct routes still work */ }
  const agents = new Map();
  const fetch = async (input, init = {}) => {
    let target = new URL(input), method = init.method ?? 'GET';
    for (let redirects = 0; ; redirects++) {
      const route = resolveRoute(target, policy, env);
      const key = route.mode === 'url' ? route.url : 'direct';
      if (!agents.has(key)) {
        if (!undici && route.mode === 'url') throw new Error('Proxy routing requires the undici package (value omitted)');
        agents.set(key, undici ? (route.mode === 'url' ? new undici.ProxyAgent(route.url) : new undici.Agent()) : null);
      }
      const response = agents.get(key)
        ? await undici.fetch(target, { ...init, method, redirect: 'manual', dispatcher: agents.get(key) })
        : await globalThis.fetch(target, { ...init, method, redirect: 'manual' });
      if (![301,302,303,307,308].includes(response.status) || init.redirect === 'manual') return response;
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();
      if (redirects >= 10 || init.redirect === 'error') throw new Error('Download redirect limit exceeded');
      const next = new URL(location, target);
      if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Refusing HTTPS downgrade');
      if (next.origin !== target.origin) {
        const headers = new Headers(init.headers);
        for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
        init = { ...init, headers };
      }
      target = next;
      // A 303 switches the method to GET, and a GET must not carry the
      // original body: undici rejects the request outright. Strip the body
      // and its framing headers so neither leaks to the next hop.
      if (response.status === 303 && method !== 'HEAD') {
        method = 'GET';
        const { body, ...rest } = init;
        init = rest;
        if (init.headers) {
          const headers = new Headers(init.headers);
          for (const name of ['content-length', 'content-type', 'transfer-encoding']) headers.delete(name);
          init = { ...init, headers };
        }
      }
    }
  };
  try { return await action(fetch); }
  finally { await Promise.all([...agents.values()].filter(agent => agent).map(agent => agent.destroy())); }
}
