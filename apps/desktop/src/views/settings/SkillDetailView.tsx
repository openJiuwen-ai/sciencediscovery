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

import type { ApiClient } from "../../api/client.js";
import { getSkill } from "../../api/settings.js";
import type { SkillDetail } from "../../api/types.js";
import { MarkdownProse } from "../../MarkdownProse.js";
import { skillMark } from "../../app/slash.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { LoadGate } from "./rows.js";

interface Props {
  client: ApiClient;
  skillId: string;
}

/** Frontmatter keys that are already on the page: the name and description in
 *  the header, the version beside them, and the resource list in 文件. */
const SHOWN_ELSEWHERE = new Set(["name", "description", "version"]);

/** One frontmatter value as a reader can read it, or nothing.
 *
 *  A SKILL.md may declare any key it likes — `category`, `requirements`, a
 *  licence — and the package keeps them. A key whose value is a nested object
 *  or an empty string has nothing to say on a fact line, so it is left out
 *  rather than printed as `[object Object]` or a blank. */
function factValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    const text = value.map(String).filter((item) => item.trim().length > 0);
    return text.length === 0 ? undefined : text.join(", ");
  }
  return undefined;
}

/** A fact's label: the two canonical fields the app names itself, and the
 *  package's own key for everything else, with punctuation turned back into
 *  words (`allowed-tools` → `Allowed tools`). */
function factLabel(key: string): string {
  if (key === "license") return TEXT.settings.skills.license;
  if (key === "compatibility") return TEXT.settings.skills.compatibility;
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailFacts(detail: SkillDetail): Array<{ label: string; value: string }> {
  const entries = Object.entries(detail.frontmatter)
    .filter(([key]) => !SHOWN_ELSEWHERE.has(key))
    .flatMap(([key, raw]) => {
      const value = factValue(raw);
      return value === undefined ? [] : [{ key, label: factLabel(key), value }];
    });
  // The licence leads, as it does in the package's own frontmatter; the rest
  // keep the order the author wrote them in.
  return entries.toSorted((left, right) => Number(right.key === "license") - Number(left.key === "license"));
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="skill-detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * 技能 › one Skill.
 *
 * The row used to open SKILL.md in place, which made the instructions a
 * squeezed box inside a list item. A Skill is a package — a document and the
 * files beside it — so it gets a page of its own, laid out as the document it
 * is: the identity sits at the top of the page (mark, name, source and the
 * package's own description), then the instructions run down a measured column
 * with the package's own frontmatter as 详情. Nothing is wrapped in a card,
 * because a card would put a second edge between the reader and the text.
 */
export function SkillDetailView({ client, skillId }: Props) {
  const loaded = useLoaded(async () => getSkill(client, skillId), {
    client,
    key: `skills:detail:${skillId}`,
  });

  return (
    <LoadGate loaded={loaded}>
      {(detail) => {
        const facts = detailFacts(detail);
        const source = detail.source === "built-in"
          ? TEXT.settings.skills.source.builtIn
          : TEXT.settings.skills.source.managed;
        return (
          <div className="skill-detail">
            <header className="skill-detail-head">
              <div className="skill-detail-title">
                <span aria-hidden="true" className="skill-detail-mark">{skillMark(detail)}</span>
                <h3>{detail.name}</h3>
                <span className={`skill-source-badge ${detail.source === "built-in" ? "is-sd" : "is-managed"}`}>
                  {source}
                </span>
              </div>
              {detail.description ? (
                <p className="skill-detail-description">{detail.description}</p>
              ) : null}
            </header>

            <section className="skill-detail-section">
              <h4>{TEXT.settings.skills.detailView.files}</h4>
              <article className="skill-detail-file text">
                <MarkdownProse>{detail.instructions}</MarkdownProse>
              </article>
            </section>

            {facts.length === 0 ? null : (
              <section className="skill-detail-section">
                <h4>{TEXT.settings.skills.detail}</h4>
                <div className="skill-detail-meta-card">
                  {facts.map((fact) => <DetailRow key={fact.label} label={fact.label} value={fact.value} />)}
                </div>
              </section>
            )}
          </div>
        );
      }}
    </LoadGate>
  );
}
