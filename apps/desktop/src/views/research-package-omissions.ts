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

/**
 * How one manifest omission is shown in the import dialog.
 *
 * `manifest.omissions` mixes two kinds of entry (#1024, owner decision on
 * PR #1282):
 *
 * - machine tokens such as `cas:…`, `artifact:…`, `trajectory:…`,
 *   `workspace:…`, `evolve:…` and `version:…`, which name one missing object,
 *   run or file and therefore stay byte-for-byte as authored;
 * - explanatory sentences that the API writes as fixed strings in
 *   `services/api/src/research-snapshots.ts`. Those sentences are Chinese in
 *   the manifest, which used to leak into the English dialog; they follow the
 *   active dialog language here instead.
 *
 * The carry is a client-side map of the known sentences rather than a new
 * language-neutral marker in the package manifest: exported `.sdresearch` files
 * already contain the current plain strings, so a manifest change would need a
 * schema revision and old packages would keep showing the Chinese prose. The
 * cost is that a rewritten server sentence is no longer recognized and is
 * printed as authored; that is the safe fallback, and the desktop regression
 * tests pin the exact sentences this map knows.
 */
import { TEXT, type Text } from "../text.js";

type ResearchPackageText = Text["researchPackage"];
type ScopeLabelKey = keyof ResearchPackageText["omissionScopeLabels"];

/** Fixed prose from `research-snapshots.ts`, matched verbatim. */
const MEMORY_SUMMARY = "科学记忆以摘要形式保留；完整科学记忆节点和关系未包含在本包中。";
const INHERITED_MEMORY_SUMMARY = "来源只有科学记忆摘要，无法从摘要恢复完整节点和关系。";
const INHERITED_HISTORY = "来源包含必要导入的研究记录；完整导出仅包含当前已有内容，无法补回原包省略的历史。";
const NECESSARY_SCOPE = "必要导出保留当前结果及依赖证据；不包含完整历史版本、思考分片和原始事件流。直接溯源引用的执行代码和日志保留原文，其余历史执行默认不带。继续研究仅复制本包已有内容。";
/** `导出范围省略${label}：${count}。` — the label is authored alongside the sentence. */
const TRIMMED_SCOPE = /^导出范围省略(.+?)：(\d+)。$/u;

/** The API's Chinese count labels, mapped to the key of the localized label. */
const SCOPE_LABELS: Record<string, ScopeLabelKey> = {
  会话: "sessions", 消息: "messages", 产物: "artifacts", 产物版本: "artifactVersions",
  工作区文件: "workspaceFiles", 执行记录: "executionRuns", 任务: "runs",
  原始运行事件: "runEvents", 轨迹事件: "trajectoryEvents", 文件修订: "fileRevisions",
  科学记忆节点: "memoryNodes", 科学记忆关系: "memoryEdges",
};

/**
 * One omission entry, in the active language. Machine tokens and unknown text
 * pass through unchanged; a non-string entry (a malformed manifest) becomes a
 * localized placeholder instead of throwing during render.
 */
export function formatOmission(entry: unknown, t: ResearchPackageText = TEXT.researchPackage): string {
  if (typeof entry !== "string") return t.omissionUnreadable;
  switch (entry) {
    case MEMORY_SUMMARY: return t.omissionMemorySummary;
    case INHERITED_MEMORY_SUMMARY: return t.omissionInheritedMemorySummary;
    case INHERITED_HISTORY: return t.omissionInheritedHistory;
    case NECESSARY_SCOPE: return t.omissionNecessaryScope;
  }
  const scope = TRIMMED_SCOPE.exec(entry);
  if (scope) {
    const kind = SCOPE_LABELS[scope[1]!];
    return t.omissionScopeTrimmed(kind ? t.omissionScopeLabels[kind] : scope[1]!, Number(scope[2]));
  }
  return entry;
}
