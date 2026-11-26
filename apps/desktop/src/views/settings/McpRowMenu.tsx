// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { CustomMcpServerDetails } from "@sciencediscovery/schema";
import { TEXT } from "../../text.js";
import { SettingsRowMenu, type SettingsRowMenuItem } from "./SettingsRowMenu.js";

export type McpRowAction = "tools" | "test" | "edit" | "authorize" | "cancelAuthorization" | "clearAuthorization" | "delete";

const paths: Record<McpRowAction | "open", string> = {
  tools: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  test: "m8 12 3 3 5-6M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z",
  edit: "M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7m-1.6-8.4 2.9 2.9-7.1 7.1-3.5.7.7-3.5z",
  authorize: "M8 10V7a4 4 0 0 1 8 0v3M6 10h12v10H6zM12 14v3",
  cancelAuthorization: "m9 9 6 6m0-6-6 6M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z",
  clearAuthorization: "M8 10V7a4 4 0 0 1 8 0M6 10h12v10H6zM3 3l18 18",
  delete: "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7M10 11v5m4-5v5",
  open: "M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
};
const glyph = (kind: keyof typeof paths) => (
  <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round"
    strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14"><path d={paths[kind]} /></svg>
);

export function McpRowMenu({ authorization, authorizationUrl, disabled, name, onAction }: {
  authorization?: CustomMcpServerDetails["authorization"];
  authorizationUrl?: string;
  disabled: boolean;
  name: string;
  onAction: (action: McpRowAction) => void;
}) {
  const t = TEXT.settings.system.mcp;
  const item = (key: McpRowAction, label: string): SettingsRowMenuItem => ({
    key, label, icon: glyph(key), onSelect: () => onAction(key),
  });
  const items = [item("tools", t.tools), item("test", t.test), item("edit", TEXT.settings.edit)];
  if (authorization) {
    items.push({ ...item("authorize", t.authorize), disabled: authorization.state === "authorizing" });
    if (authorization.state === "authorizing") {
      items.push(item("cancelAuthorization", t.cancelAuthorization));
      if (authorizationUrl) items.push({ key: "open", label: t.openAuthorization, icon: glyph("open"), href: authorizationUrl });
    }
    items.push({ ...item("clearAuthorization", t.clearAuthorization), danger: true, separatorBefore: true });
  }
  items.push({ ...item("delete", TEXT.menu.delete), danger: true, separatorBefore: !authorization });
  return <SettingsRowMenu className="mcp-row-menu" disabled={disabled} items={items} label={t.actions(name)} />;
}
