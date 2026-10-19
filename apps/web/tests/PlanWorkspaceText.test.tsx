// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanPanel } from "@sciencediscovery/plan/web";
import { en, zhCN } from "../src/i18n/messages.js";

function assertPlanText(messages: typeof en | typeof zhCN) {
  const url = `https://example.test/research/${"a".repeat(140)}`;
  const agent = `subagent:${"research".repeat(30)}`;
  const t = (key: keyof typeof en, variables: Record<string, string | number> = {}) =>
    messages[key].replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? name));
  const html = renderToStaticMarkup(createElement(PlanPanel, {
    t, icons: { check: "✓", spinner: "◌", chevron: "›" },
    cardIdFor: () => "plan", expandedCards: { plan: true }, onToggleCard: () => {},
    plans: [{ runId: "run", agentId: agent, explanation: url,
      items: Array.from({ length: 8 }, (_, i) => ({ step: `${i}: ${url}`, status: i < 3 ? "completed" as const : i < 6 ? "in_progress" as const : "pending" as const })) }],
  }));
  assert.ok(html.includes(`title="${t("plan.title", { agent })}"`));
  assert.ok(html.includes(`${t("plan.summary", { completed: 3, total: 8 })} · ${t("plan.summaryActive", { active: 3 })}`));
  assert.ok(html.includes(`<i>${t("plan.status.inProgress")}</i>`));
  assert.ok(html.includes(`aria-label="${t("plan.sectionAria")}"`));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.equal(html.split(url).length - 1, 9, "explanation and all eight steps retain the complete URL");
  assert.equal((html.match(/class="plan-item-status completed"/g) ?? []).length, 3);
  assert.equal((html.match(/class="plan-item-status in_progress"/g) ?? []).length, 3);
  assert.equal((html.match(/class="plan-item-status pending"/g) ?? []).length, 2);
}

test("Workspace Plan preserves full long text and active progress (en)", () => {
  assertPlanText(en);
});

test("Workspace Plan preserves full long text and active progress (zh)", () => {
  assertPlanText(zhCN);
});
