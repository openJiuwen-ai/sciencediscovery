// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Extraction prompt construction — the exact prompt shape the DeepAnalyze
 * pipeline converged on (bibliographic-metadata bans, canonical-name reuse,
 * verbatim evidence requirement). The prompt is Chinese because that is
 * what the production thresholds were tuned against; the source text may be
 * any language.
 */

import type { ExtractionSchema } from "./schema.js";

export const PROMPT_TEXT_CAP = 16_000;
export const HAYSTACK_CAP = 200_000;
export const MAX_ENTITIES = 30;
export const MAX_RELATIONS = 40;

export interface ExtractionPromptOptions {
  readonly schema: ExtractionSchema;
  /** Known hub entities as "name (type)" lines — the model must reuse their
   *  exact names for the same concepts (hub-split prevention). */
  readonly coreEntityLines?: readonly string[];
  readonly maxEntities?: number;
  readonly maxRelations?: number;
}

export function buildExtractionPrompt(documentText: string, options: ExtractionPromptOptions): string {
  const maxEntities = options.maxEntities ?? MAX_ENTITIES;
  const maxRelations = options.maxRelations ?? MAX_RELATIONS;
  const coreSection =
    options.coreEntityLines && options.coreEntityLines.length > 0
      ? `\n\n以下是本知识库已确立的核心实体（名称 (类型)）。若文档中的概念与其中之一相同，必须复用该确切名称作为 name：\n${options.coreEntityLines.join("\n")}`
      : "";

  return `从以下文档内容中提取学科知识实体以及实体之间的关系。

实体抽取规则：
1. 只抽取学科知识本身的实体：概念、方法、框架、架构、指标、数据集、基准、任务、理论、材料、物质、工具。
2. 严禁抽取文献元信息：作者、人名、机构、大学、实验室、公司、会议、期刊、论文标题。这些不是学科知识。
3. 严禁抽取过于泛化的词：如"结果"、"性能"、"实验"、"方法"（无具体所指时）、单字母变量、纯数字。
4. 每个实体包含 name（规范名称）、type（类型，从以下选择：${options.schema.entityTypes.join("/")}）、definition（一句话定义，可选）、aliases（别名数组，可选）。
5. 最多 ${maxEntities} 个实体，宁可少而准，不要多而杂。
6. name 使用该概念在领域内最通用的规范全称（保持原文大小写惯例）；缩写、别称、中英文异名全部放入 aliases，同一概念只输出一次。
7. 若正文出现"全称 (缩写)"的定义形式，name 用全称、aliases 含缩写。

关系抽取规则：
1. 提取实体间的关系（最多 ${maxRelations} 条）。每条关系包含 source（源实体名）、target（目标实体名）、type（关系类型，从以下选择：${options.schema.edgeTypes.join("/")}）、evidence_quote（证明该关系的原文句子，必须是文档中逐字出现的完整句子，不得改写）。
2. 只提取文档中明确陈述的关系，不得推测。

只返回 JSON 对象，格式：{"entities": [...], "relations": [...]}，不要输出其他内容。${coreSection}

文档内容：
${documentText.slice(0, PROMPT_TEXT_CAP)}`;
}
