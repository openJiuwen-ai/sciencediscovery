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
 * 哪些工具的调用要进入记忆图谱。
 *
 * 这是全库唯一的判断源：在表 = 入图，不在 = 不入图。
 *
 * 设计要点：
 * - 不按 kind / source kinds 推导（推导规则会过时，显式登记不会）
 * - MCP 工具同样显式登记，不做自动推导
 * - 启用 web_fetch / lookup / analysis 时只需加行（"启用工具的成本 = 表加一行"）
 *
 * 一行登记回答两个不同的问题，所以值是一个对象而不是一个字符串：
 * - ``type``  → ``ToolCall.tool_type``，节点上的粗分类标签，词表只有
 *   execution / search（外加 sidecar 独占的 program_evolution），**绝不与任何
 *   工具名同名**——"web_fetch 的类型是 web_search"那种把工具名当类型名的写法
 *   会让读卡片的人分不清哪边是工具、哪边是分类。
 * - ``product`` → 发射器选产物形状（paper / web_page / db_record / code）、
 *   落哪类产物节点、去重键。它曾经和 ``type`` 是同一个值，于是收缩词表时
 *   MCP 文献/网页产物会被静默发射成 DbRecord；拆开正是为了让两个问题各自
 *   有独立的、可穷尽检查的答案。
 *
 * sidecar 通用 upsert 查这张表；broker 用 ``toolGraphSpec`` 一次取两个值。
 */

export type ToolGraphType =
  | "execution" // 执行工具（run_shell / run_npu_job；run_python 走 recorder 直连）
  | "search"; // 检索/抓取工具：文献源、wiki、数据库源、web_search / web_fetch
// ``program_evolution`` 由 sidecar 的 evolve 写入端（search_graph.py）直接写，
// 没有对应的工具行——注册表里不会有任何一行取这个值，它是词表里唯一
// "不是工具的类型"。词表冻结测试会守住这一点。

/** 产物形状：发射器的派发键，决定落哪类节点、走哪条去重键，不上节点。 */
export type ToolGraphProduct =
  | "code" // Code（走 recorder 路径）
  | "paper" // Paper
  | "web_page" // WebPage
  | "db_record"; // DbRecord

export interface ToolGraphSpec {
  readonly type: ToolGraphType;
  readonly product: ToolGraphProduct;
}

export const TOOL_GRAPH_REGISTRY: Record<string, ToolGraphSpec> = {
  // ── Workspace ──
  run_shell: { type: "execution", product: "code" },
  run_npu_job: { type: "execution", product: "code" },
  web_search: { type: "search", product: "web_page" },
  web_fetch: { type: "search", product: "web_page" },
  // ── MCP 文献源 ──
  "mcp__arxiv__search": { type: "search", product: "paper" },
  "mcp__pubmed__search": { type: "search", product: "paper" },
  "mcp__europe-pmc__search": { type: "search", product: "paper" },
  "mcp__biorxiv__search_preprints": { type: "search", product: "paper" },
  "mcp__medrxiv__search_preprints": { type: "search", product: "paper" },
  // ── MCP wiki 源 ──
  "mcp__llm-wiki__search": { type: "search", product: "web_page" },
  // get_page / get_pages read a page's full text: the products are still
  // WebPage nodes, but the broker additionally pulls the body into the CAS
  // data pool and mirrors content_hash — same product shape and same write
  // path as snippet-only pages, the difference is the extra contentHash.
  "mcp__llm-wiki__get_page": { type: "search", product: "web_page" },
  "mcp__llm-wiki__get_pages": { type: "search", product: "web_page" },
  // ── MCP 数据库源 ──
  "mcp__uniprot__search": { type: "search", product: "db_record" },
  "mcp__pdb__search_structures": { type: "search", product: "db_record" },
  "mcp__reactome__search_pathways": { type: "search", product: "db_record" },
  "mcp__clinvar__search_variants": { type: "search", product: "db_record" },
  "mcp__chembl__search_molecules": { type: "search", product: "db_record" },
  "mcp__chembl__search_targets": { type: "search", product: "db_record" },
  "mcp__chembl__search_activities": { type: "search", product: "db_record" },
  "mcp__chembl__similarity_search": { type: "search", product: "db_record" },
  "mcp__geo__search_studies": { type: "search", product: "db_record" },
};
// 暂缓（附录 B/E），启用时加行 + 需要的话加产出形状：
// - db_lookup     数据库精确查询 → DbRecord / WebPage
// - analysis      计算分析 → ToolCall only（设计未定）

/**
 * 查表：返回该工具的两个登记值，未登记返回 undefined。
 *
 * 调用方约定：undefined = "不在图里"，不视为错误。
 * 不做"未登记提示"——不在表是产品决策，不是错误。
 */
export function toolGraphSpec(toolName: string): ToolGraphSpec | undefined {
  return TOOL_GRAPH_REGISTRY[toolName];
}

/** 只要分类标签时用这个（前端/展示侧），否则用 ``toolGraphSpec``。 */
export function toolGraphType(toolName: string): ToolGraphType | undefined {
  return TOOL_GRAPH_REGISTRY[toolName]?.type;
}
