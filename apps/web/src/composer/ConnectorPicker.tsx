// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ComponentProps } from "react";
import { ConnectorPicker as McpPicker } from "@sciencediscovery/mcp/web";
import { DatabaseIcon, ExternalIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";
import { useDisabledPlugins } from "../plugins/host.js";
export { connectorName } from "@sciencediscovery/mcp/web";
export function ConnectorPicker(props:Omit<ComponentProps<typeof McpPicker>,"t"|"icons">) {
  const {t}=useLocale(), disabled=useDisabledPlugins();
  if (disabled.includes("mcp")) return null;
  return <McpPicker {...props} connectors={props.connectors.filter(item=>!disabled.includes(`connector.${item.id}`))}
    t={t} icons={{database:<DatabaseIcon size={15}/>,external:<ExternalIcon size={13}/>}}/>;
}
