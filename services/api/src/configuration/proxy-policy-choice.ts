// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ProxyPolicy } from "@sciencediscovery/schema";
import { invalid } from "./validation.js";

/** Accept only a policy the preview would offer: inherit, none, or a registered proxy. */
export function previewedProxyPolicy(value: unknown, servers: readonly { id: string }[]): ProxyPolicy {
  if (value === "inherit" || value === "none") return value;
  if (typeof value === "string" && value.startsWith("proxy:")) {
    const serverId = value.slice("proxy:".length);
    if (serverId.length > 0 && serverId.length <= 200 && servers.some(server => server.id === serverId)) {
      return `proxy:${serverId}`;
    }
  }
  invalid("Choose inherit, none or an existing registered proxy", "proxyPolicy");
}
