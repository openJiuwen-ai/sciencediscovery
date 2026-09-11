// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useState } from "react";
import type { SkillReviewDraftSummary, ToolTrace } from "@sciencediscovery/schema";
import { useLocale } from "./i18n/index.js";
import { CheckIcon } from "./icons.js";
import { ProcessRecord } from "./ProcessRecord.js";

/** create_skill appends a fixed review instruction after its JSON result. */
export function skillDraftFromOutput(output: string | undefined): { draftId: string; name?: string } | undefined {
  if (!output) return undefined;
  try {
    const result: unknown = JSON.parse(output.split("\n\nThe Skill is a pending draft")[0]!);
    if (!result || typeof result !== "object" || !("draftId" in result) || typeof result.draftId !== "string" || !result.draftId) return undefined;
    return { draftId: result.draftId, ...("name" in result && typeof result.name === "string" ? { name: result.name } : {}) };
  } catch { return undefined; }
}

export function SkillReviewRecords({ traces, listDrafts, onOpen }: {
  traces: ToolTrace[];
  listDrafts?: () => Promise<SkillReviewDraftSummary[]>;
  onOpen: (name?: string) => void;
}) {
  const { t } = useLocale();
  const drafts = traces.map((trace) => ({ trace, draft: skillDraftFromOutput(trace.output) }));
  const signature = JSON.stringify(drafts.map(({ trace, draft }) => [trace.id, draft?.draftId]));
  const [snapshot, setSnapshot] = useState<{ signature: string; pending: Set<string> }>();
  useEffect(() => {
    if (!listDrafts) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = traces.map((trace) => skillDraftFromOutput(trace.output)?.draftId).filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    async function refresh() {
      try {
        const result = await listDrafts!();
        if (disposed) return;
        const pending = new Set(result.map((draft) => draft.draftId));
        setSnapshot({ signature, pending });
        if (!ids.some((id) => pending.has(id))) return;
      } catch {
        // A failed refresh is not evidence that review finished.
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [listDrafts, signature]);
  return <>{drafts.map(({ trace, draft }) => {
    const processed = Boolean(draft && snapshot?.signature === signature && !snapshot.pending.has(draft.draftId));
    const name = draft?.name ?? (typeof trace.args?.name === "string" ? trace.args.name : undefined);
    const label = name ?? draft?.draftId ?? trace.id;
    return <ProcessRecord key={draft?.draftId ?? trace.id} active={!processed}
      label={t("record.skillReviewed", { name: label })}>
      <aside className="skill-review-timeline-cta">
        <span className="skill-review-timeline-icon"><CheckIcon size={17} /></span>
        <div><strong>{processed ? t("record.skillReviewed", { name: label }) : t("timeline.skillDraftReady")}</strong>
          {!processed ? <small>{t("timeline.skillDraftReadyDescription")}</small> : null}</div>
        <button onClick={() => onOpen(name)} type="button">{t("timeline.reviewSkill")}</button>
      </aside>
    </ProcessRecord>;
  })}</>;
}
