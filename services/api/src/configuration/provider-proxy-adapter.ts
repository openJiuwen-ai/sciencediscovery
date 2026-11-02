// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues, ProxyPolicy } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";
export function createProviderProxyAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "proxy.provider", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input=object(raw,["providerId","proxyPolicy"],"values"),output:ConfigurationValues={};
      if (input.providerId !== undefined) {
        if (typeof input.providerId !== "string" || !input.providerId.trim() || input.providerId.length > 200) {
          invalid("Select an existing provider", "providerId");
        }
        output.providerId = input.providerId.trim();
      }
      if (input.proxyPolicy !== undefined) {
        if (typeof input.proxyPolicy !== "string" || !["inherit", "none", ...store.configurationProviderProxySettings().servers.map(server => `proxy:${server.id}`)].includes(input.proxyPolicy)) {
          invalid("Choose inherit, none or an existing registered proxy", "proxyPolicy");
        }
        output.proxyPolicy = input.proxyPolicy;
      }
      return output;
    }, target: input=>String(input.providerId??""),
    preview: (input,snapshot)=>{
      const source=snapshot.data.providerProxySettings as ReturnType<SessionStore["configurationProviderProxySettings"]>,provider=source.providers.find(provider=>provider.id===input.providerId);
      if(input.providerId!==undefined&&!provider)throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE","The selected model provider is no longer available",409,"providerId");
      const value=String(input.proxyPolicy??provider?.proxyPolicy??"inherit"),choices=[{id:"inherit",label:"Inherit the deployment default"},{id:"none",label:"Direct connection"},...source.servers.map(server=>({id:`proxy:${server.id}`,label:`${server.name} (${server.kind})`}))];
      if(!choices.some(choice=>choice.id===value))invalid("The selected proxy is no longer registered","proxyPolicy");
      const changes=provider&&input.proxyPolicy!==undefined&&value!==provider.proxyPolicy?[{field:"proxyPolicy",before:provider.proxyPolicy,after:value}]:[];
      return {fields:[{id:"providerId",label:"Model provider",kind:"enum",required:true,choices:source.providers.map(provider=>({id:provider.id,label:`${provider.name} · ${provider.modelCount} models`})),...(provider?{value:provider.id}:{})},
        {id:"proxyPolicy",label:"Provider proxy policy",kind:"enum",required:true,value,choices}],changes,
        impact:{resourceLocation:"Shared model provider proxy policy",effectiveScope:provider?`${provider.name} and its ${provider.modelCount} model profiles`:"Choose an existing shared provider",
          message:"All models belonging to the selected provider share this route. Later connection setup may use the new proxy; existing sockets, clients and in-flight requests may retain their old route. inherit follows the deployment default; none explicitly bypasses proxies. The proxy may receive traffic, while destination/domain/private-network and tool permissions remain separate. No provider endpoint, token, proxy URL or other provider is changed. No connection test, model call, restart or task resume occurs; saving does not prove reachability or transport privacy."},
        verificationPlan:{targets:[],actions:[],maxRequests:0,mayCharge:false},activationMode:"next_run",disposition:!provider||input.proxyPolicy===undefined?"missing_input":changes.length?"change":"no_change",ready:changes.length>0};
    },
    apply: context=>{
      store.applyProviderProxyConfigurationSync(String(context.input.providerId),String(context.input.proxyPolicy) as ProxyPolicy);
      return {resourceRevision:digest(store.configurationSnapshot(context.sessionId,"proxy.provider",String(context.input.providerId)).resourceVersions),summary:"Shared provider proxy policy saved; connectivity and existing clients remain unverified"};
    },
  };
}
