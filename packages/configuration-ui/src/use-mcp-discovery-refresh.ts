// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useRef } from "react";
import type { CustomMcpServerDetails } from "@sciencediscovery/schema";

/** 在后台发现期间串行更新设置页，页面离开或到达期限后丢弃迟到结果。 */
export function useMcpDiscoveryRefresh(
  client: object,
  servers: readonly Pick<CustomMcpServerDetails, "id" | "enabled" | "status">[] | undefined,
  refresh: (isCurrent: () => boolean) => Promise<void>,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pending = servers?.filter((server) => server.enabled && server.status === "untested")
    .map((server) => server.id).sort().join(",") ?? "";

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => { active = false; clearTimeout(timer); }, 120_000);
    const poll = async (): Promise<void> => {
      if (!active) return;
      try {
        await refreshRef.current(() => active);
        if (active) timer = setTimeout(() => void poll(), 1_000);
      } catch {
        active = false;
        clearTimeout(deadline);
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => { active = false; clearTimeout(timer); clearTimeout(deadline); };
  }, [client, pending]);
}
