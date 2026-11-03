// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";

export function createProxyDefaultConfigurationAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "proxy.default", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["defaultPolicy"], "values");
      if (input.defaultPolicy === undefined) return {};
      const value = input.defaultPolicy;
      if (typeof value !== "string" || !["none", ...store.configurationProxyDefaults().servers.map(server => `proxy:${server.id}`)].includes(value))
        invalid("Choose none or an existing registered proxy ID; the global default cannot inherit", "defaultPolicy");
      return { defaultPolicy: value };
    },
    target: () => "proxy.default",
    preview: (input, snapshot, scope) => {
      const current = snapshot.data.proxyDefaults as ReturnType<SessionStore["configurationProxyDefaults"]>;
      const value = String(input.defaultPolicy ?? current.defaultPolicy);
      const changes = input.defaultPolicy !== undefined && value !== current.defaultPolicy ? [{ field: "defaultPolicy", before: current.defaultPolicy, after: value }] : [];
      const statement = "Independently approve changing the deployment's inherited outbound route. Sandbox egress and later model, Web and MCP requests can use this route, including requests that carry credentials.";
      return { fields: [{ id: "defaultPolicy", label: "Deployment default proxy policy", kind: "enum", required: false, value,
        choices: [{ id: "none", label: "Direct connection (none)" }, ...current.servers.map(server => ({ id: `proxy:${server.id}`, label: `${server.name} (${server.kind})` }))] }],
        changes, impact: { resourceLocation: "Deployment proxy default", effectiveScope: "All outbound modules that inherit the deployment default",
          message: "This changes the route for later inheriting model, Web, MCP and other outbound connections, including sandbox egress that inherits the default. Explicit module proxy selections stay unchanged. Destination/domain/private-network permissions and tool execution still require their own authorization. Existing sockets, clients or in-flight requests may keep their old route. No proxy is created, credentials changed, service restarted or connection tested; saving does not prove that the proxy is reachable." },
        ...(changes.length ? { securityConsent: { targetDigest: digest([value, scope, snapshot.resourceVersions]), statement } } : {}),
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: input.defaultPolicy === undefined ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      store.applyProxyDefaultConfigurationSync(String(context.input.defaultPolicy));
      return { summary: "Deployment proxy default saved; proxy connectivity and existing client reconfiguration were not verified" };
    },
  };
}
