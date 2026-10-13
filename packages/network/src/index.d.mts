// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
export type NetworkProxy = { mode: 'environment' | 'direct'; noProxy?: string } | { mode: 'url'; url: string; noProxy?: string };
export const proxyVariables: string[];
export function isLoopback(url: string | URL): boolean;
export function bypassesProxy(url: string | URL, entries?: string): boolean;
export function validateProxyUrl(url: string): string;
export function resolveRoute(target: string | URL, policy?: NetworkProxy, env?: Record<string, string | undefined>): {mode:'direct'} | {mode:'url';url:string};
export function proxyProcessEnvironment(policy?: NetworkProxy, base?: Record<string, string | undefined>): Record<string, string | undefined>;
export function redactNetworkError(error: unknown): string;
export function withProxyFetch<T>(policy: NetworkProxy, action: (fetch: typeof globalThis.fetch) => Promise<T>, env?: Record<string, string | undefined>): Promise<T>;
