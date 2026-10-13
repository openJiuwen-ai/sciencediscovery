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
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search) {
    throw new Error('Proxy URL must use HTTP, HTTPS or SOCKS5 without query or fragment (value omitted)');
  }
  return url;
}

export function resolveRoute(target, policy = { mode: 'environment' }, env = process.env) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) targets are supported');
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
    if (candidate) env[name] = env[name.toUpperCase()] = validateProxyUrl(candidate);
  }
  const bypass = [policy.noProxy ?? value(base, 'no_proxy'), 'localhost', '127.0.0.1', '[::1]'].filter(Boolean).join(',');
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
  const { Agent, ProxyAgent, fetch: undiciFetch } = await import('undici');
  const agents = new Map();
  const fetch = async (input, init = {}) => {
    let target = new URL(input), method = init.method ?? 'GET';
    for (let redirects = 0; ; redirects++) {
      const route = resolveRoute(target, policy, env);
      const key = route.mode === 'url' ? route.url : 'direct';
      if (!agents.has(key)) agents.set(key, route.mode === 'url' ? new ProxyAgent(route.url) : new Agent());
      const response = await undiciFetch(target, { ...init, method, redirect: 'manual', dispatcher: agents.get(key) });
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
      if (response.status === 303 && method !== 'HEAD') method = 'GET';
    }
  };
  try { return await action(fetch); }
  finally { await Promise.all([...agents.values()].map(agent => agent.destroy())); }
}
