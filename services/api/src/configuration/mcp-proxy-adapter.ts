// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { previewedProxyPolicy } from "./proxy-policy-choice.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";
export function createMcpProxyAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "proxy.mcp", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input=object(raw,["mcpServerId","proxyPolicy"],"values"),output:ConfigurationValues={};
      if (input.mcpServerId !== undefined) {
        if (typeof input.mcpServerId !== "string" || !input.mcpServerId.trim() || input.mcpServerId.length > 200) {
          invalid("Select an existing MCP server", "mcpServerId");
        }
        output.mcpServerId = input.mcpServerId.trim();
      }
      if (input.proxyPolicy !== undefined) output.proxyPolicy = previewedProxyPolicy(input.proxyPolicy, store.configurationMcpProxySettings().servers);
      return output;
    }, target: input=>String(input.mcpServerId??""),
    preview: (input,snapshot)=>{
      const source=snapshot.data.mcpProxySettings as ReturnType<SessionStore["configurationMcpProxySettings"]>,service=source.services.find(service=>service.id===input.mcpServerId);
      if(input.mcpServerId!==undefined&&!service)throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE","The selected MCP server is no longer available",409,"mcpServerId");
      const value=String(input.proxyPolicy??service?.proxyPolicy??"inherit"),choices=[{id:"inherit",label:"Inherit the deployment default"},{id:"none",label:"Direct connection"},...source.servers.map(server=>({id:`proxy:${server.id}`,label:`${server.name} (${server.kind})`}))];
      if(!choices.some(choice=>choice.id===value))invalid("The selected proxy is no longer registered","proxyPolicy");
      const changes=service&&input.proxyPolicy!==undefined&&value!==service.proxyPolicy?[{field:"proxyPolicy",before:service.proxyPolicy,after:value}]:[];
      return {fields:[{id:"mcpServerId",label:"MCP server",kind:"enum",required:true,choices:source.services.map(service=>({id:service.id,label:`${service.id} · ${service.connectorIds.length} connectors · ${service.name}`})),...(service?{value:service.id}:{})},
        {id:"proxyPolicy",label:"MCP server proxy policy",kind:"enum",required:true,value,choices}],changes,
        impact:{resourceLocation:"Shared MCP server proxy policy",effectiveScope:service?`${service.id} · ${service.name} · ${service.connectorIds.length} connectors`:"Choose an existing MCP server",
          message:"All connectors sharing this MCP server share this policy. Future calls or connections may use the new route; existing connections and in-flight requests may retain their old route. STDIO programs may ignore proxy environment variables, and HTTP MCP transports do not guarantee proxy support. inherit follows the deployment default; none explicitly bypasses proxies. The proxy may receive traffic; network, private-network and tool permissions remain separate. The settings writer does not refresh the catalog, reconnect a service, launch a process, invoke a tool or test connectivity. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Actual transport routing remains unverified."},
        verificationPlan:{targets:[],actions:[],maxRequests:0,mayCharge:false},activationMode:"next_connection",disposition:!service||input.proxyPolicy===undefined?"missing_input":changes.length?"change":"no_change",ready:changes.length>0};
    },
    apply: context=>{
      const policy=previewedProxyPolicy(context.input.proxyPolicy,store.configurationMcpProxySettings().servers);
      store.applyMcpProxyConfigurationSync(String(context.input.mcpServerId),policy);
      return {resourceRevision:digest(store.configurationSnapshot(context.sessionId,"proxy.mcp",String(context.input.mcpServerId)).resourceVersions),summary:"MCP server proxy policy saved; connectivity and existing clients remain unverified"};
    },
  };
}
