// Copyright (C) 2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { proxyDispatcher, proxyFetch } from "@sciencediscovery/data-source";
import type { ResolvedProxy } from "@sciencediscovery/schema";

/** 将运行时 Request 转成 undici 可接收的参数，保留流式请求体与取消信号。 */
export function fetchMcpRequest(request: Request, proxy: ResolvedProxy = { mode: "environment" }): Promise<Response> {
  const dispatcher = proxyDispatcher(proxy, new URL(request.url));
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    redirect: "error",
    ...(request.body ? { duplex: "half" as const } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };
  return proxyFetch(request.url, init);
}
