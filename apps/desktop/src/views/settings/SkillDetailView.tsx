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
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { Group, LoadGate, Switch, Tag } from "./rows.js";
import { skillMeta } from "./skill-meta.js";

interface Props {
  /** A write is already in flight; the switch waits for it. */
  busy?: boolean;
  client: ApiClient;
  /** Whether this Skill is switched on, read from JiuwenSwarm by the list. */
  enabled: boolean;
  onToggle: (next: boolean) => void;
  skillId: string;
  skillName: string;
  /** Writes to the switch are not possible while a write is in flight, or
   *  when the active backend has no skill store to write to. */
  switchesAvailable: boolean;
}

function frontmatterString(detail: SkillDetail, key: string): string {
  const value = detail.frontmatter[key];
  return typeof value === "string" ? value.trim() : "";
}

function sourceLabel(source: SkillDetail["source"]): string {
  return source === "built-in" ? TEXT.settings.skills.source.builtIn : TEXT.settings.skills.source.managed;
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
 * files beside it — so it gets a page of its own: what the model is told,
 * where the package came from, and whether it is available. The header above
 * the page carries its name, description and the way back to the list.
 */
export function SkillDetailView({
  busy,
  client,
  enabled,
  onToggle,
  skillId,
  skillName,
  switchesAvailable,
}: Props) {
  const loaded = useLoaded(async () => getSkill(client, skillId), {
    client,
    key: `skills:detail:${skillId}`,
  });

  return (
    <LoadGate loaded={loaded}>
      {(detail) => {
        const license = frontmatterString(detail, "license");
        const compatibility = frontmatterString(detail, "compatibility");
        return (
          <div className="skill-detail">
            <Group heading={TEXT.settings.skills.detailView.availability}>
              <div className="settings-card skill-detail-availability">
                <div className="settings-card-main">
                  <strong>
                    {enabled ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                    <Tag tone={enabled ? "on" : "off"}>{sourceLabel(detail.source)}</Tag>
                  </strong>
                  <small>{TEXT.settings.skills.scope}</small>
                </div>
                <div className="settings-card-actions">
                  <Switch
                    disabled={busy || !switchesAvailable}
                    label={TEXT.settings.skills.toggle(skillName)}
                    onChange={onToggle}
                    value={enabled}
                  />
                </div>
              </div>
            </Group>

            <Group heading={TEXT.settings.skills.detailView.files}>
              <article className="settings-card skill-detail-file text">
                <MarkdownProse>{detail.instructions}</MarkdownProse>
              </article>
            </Group>

            <Group heading={TEXT.settings.skills.detail}>
              <div className="settings-card skill-detail-meta-card">
                <DetailRow label={TEXT.settings.skills.detailView.source} value={sourceLabel(detail.source)} />
                <DetailRow label={TEXT.settings.skills.version} value={skillMeta(detail)} />
                {license ? <DetailRow label={TEXT.settings.skills.license} value={license} /> : null}
                {compatibility
                  ? <DetailRow label={TEXT.settings.skills.compatibility} value={compatibility} />
                  : null}
              </div>
            </Group>
          </div>
        );
      }}
    </LoadGate>
  );
}
