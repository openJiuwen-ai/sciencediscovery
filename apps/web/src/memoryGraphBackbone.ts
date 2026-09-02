/**
 * 记忆图谱主干投影 + produces 折叠的纯函数层。
 *
 * 上游的 `mergeExpansions` 只折叠 subagent scope 的子树（contains 边）。
 * 单 agent session 没有 subagent scope，于是图谱一进来就是全图——没有
 * 折叠，也没有双击展开。本模块补上「每个节点的 produces 产出默认折叠，
 * 双击展开相邻一层」的交互，与上游 scope 折叠共存。
 *
 * 三条规则（见 docs 设计）：
 * 1. 默认只保留主干任务链（next 边 BFS：ResearchGoal ─next→ Task/ToolCall
 *    ─next→ ...）。produces 产出链 + citation 引用链默认折叠。
 * 2. 双击 Task（subagent scope）→ 展开子任务链（contains）——上游原生，
 *    本模块不介入。
 * 3. 双击任意非 Task 节点 → 展开相邻节点（produces + citation 方向，一
 *    层）；再双击折叠（级联）。
 *
 * 本模块是纯函数，不依赖 React/D3，方便单测。
 */
import type { MemorySubgraph, MemoryGraphEdge } from "@sciencediscovery/schema";

/**
 * produces / citation 方向的边类型。`next`（主干）和 `contains`（scope 子
 * 树）不在此列——它们各自有专门的展开路径。`supersedes` 是版本链，也折
 * 叠但属于 Artifact 自身的版本演化，先归入 produces 方向一起处理。
 */
const PRODUCES_EDGE_TYPES = new Set([
  "produces",
  "extracts",
  "supports",
  "stated_in",
  "input",
  "supersedes",
]);

export function isProducesEdge(edge: MemoryGraphEdge): boolean {
  return PRODUCES_EDGE_TYPES.has(edge.type);
}

/**
 * 从 ResearchGoal 出发沿 `next` 边 BFS，收集主干节点 id（ResearchGoal +
 * 所有 next 可达的 Task/ToolCall）。无 ResearchGoal 或无 next 边时回退为
 * 所有 ResearchGoal + Task + ToolCall 节点，避免空脊导致整张图被折叠掉。
 */
export function mainChainNodeIds(subgraph: MemorySubgraph): Set<string> {
  const ids = new Set<string>();
  const nextEdges = subgraph.edges.filter((e) => e.type === "next");
  // 邻接表：next 边的 source → [targets]。next 是有向的（A ─next→ B 表示 B
  // 紧跟 A），只走前向。
  const forward = new Map<string, string[]>();
  for (const e of nextEdges) {
    const arr = forward.get(e.source) ?? [];
    arr.push(e.target);
    forward.set(e.source, arr);
  }
  const researchGoals = subgraph.nodes.filter((n) => n.label === "ResearchGoal");
  // 从每个 ResearchGoal BFS 沿 next 收集主干。
  if (researchGoals.length > 0) {
    const queue: string[] = [];
    for (const rg of researchGoals) {
      ids.add(rg.id);
      queue.push(rg.id);
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of forward.get(cur) ?? []) {
        if (ids.has(next)) continue;
        ids.add(next);
        queue.push(next);
      }
    }
    // next 边可能把 Paper/Artifact 也串进来（理论上不该，但数据驱动）——
    // 主干定义只含 ResearchGoal + Task + ToolCall，过滤掉其他类型。
    const labelById = new Map(subgraph.nodes.map((n) => [n.id, n.label]));
    for (const id of [...ids]) {
      const label = labelById.get(id);
      if (label && label !== "ResearchGoal" && label !== "Task" && label !== "ToolCall") {
        ids.delete(id);
      }
    }
    return ids;
  }
  // 回退：无 ResearchGoal，主干 = 所有 ResearchGoal + Task + ToolCall。
  for (const n of subgraph.nodes) {
    if (n.label === "ResearchGoal" || n.label === "Task" || n.label === "ToolCall") {
      ids.add(n.id);
    }
  }
  return ids;
}

/**
 * ownerId 的**直接相邻** produces/citation 成员（一层，非递归）。**双向**：
 * 不管 owner 在边的 source 还是 target 端，只要边是 produces/citation
 * 类型（produces/extracts/supports/stated_in/input/supersedes），对端就是
 * 相邻成员。这样双击任意节点都能展开它所有「相连的节点」——例如
 * supports: Evidence→Claim 的 Claim 节点，前向只有 0 成员，但反向能把
 * Evidence 拉进来。
 *
 * 不含 next/contains：它们有各自的展开路径（next=主干链、contains=
 * scope 展开子任务），混进来会破坏逐层展开与主干投影。
 */
export function producesMembersOf(subgraph: MemorySubgraph, ownerId: string): Set<string> {
  const members = new Set<string>();
  for (const e of subgraph.edges) {
    if (!isProducesEdge(e)) continue;
    if (e.source === ownerId) members.add(e.target);
    else if (e.target === ownerId) members.add(e.source);
  }
  return members;
}

/**
 * 算 owner 当前还能拉进来的**新**成员：ownerId → 它**当前已折叠（不可见）
 * 的** produces/citation 相邻成员集（一层，仿 `expandedNodeMap` 的只记新节点
 * 规则）。收**当前不在可见集里**的新成员——已在图里的成员归别的 owner，
 * 不重复记到本 owner 名下。返回集即「这次双击 owner 该记到
 * expandedNodeMap[owner] 名下的新成员」。空集 → owner 无新成员可展开（走
 * toast/静默分支）。
 *
 * 「谁展开谁折叠」模型（边为中心）的关键：一个新节点只记在**第一个**拉它
 * 进来的 owner 名下。之后别的 owner 再连到它时，它已在可见集里，本函数不
 * 把它返回——于是折叠那个别的 owner 不碰它，它因还连着第一个 owner 的边
 * 而留下。这正好实现用户要的「折叠只收相邻的一条边、对端不收」。
 *
 * 双向 produces/citation 相邻、排除 next/contains，与 `producesMembersOf`
 * 一致。`visibleIds` = 当前投影图（`projectToCanvas` 返回）的节点 id 集。
 */
export function expandProducesOwner(
  subgraph: MemorySubgraph,
  ownerId: string,
  visibleIds: ReadonlySet<string>,
): Set<string> {
  const fresh = new Set<string>();
  for (const m of producesMembersOf(subgraph, ownerId)) {
    if (!visibleIds.has(m)) fresh.add(m);
  }
  return fresh;
}

/**
 * 节点 → 其 produces/citation **双向相邻**边数量的映射，一次性遍历边表
 * 构建。数边而非去重成员（调用方只关心 >0），单趟 O(E) 无 per-node Set
 * 分配。用途：`countFoldedProducesMembers` 的基线 + 保留导出（有测试覆盖）。
 * **双向**：对只有入边的节点（如 supports: Evidence→Claim 的 Claim）也
 * 能读到 >0。**必须用原始 folded subgraph 的边**——projectToCanvas 会砍掉
 * 折叠成员对应的 produces 边，投影后的边表会让每个未展开 owner 读到 0。
 */
export function buildProducesMemberCounts(subgraph: MemorySubgraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of subgraph.edges) {
    if (!isProducesEdge(e)) continue;
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
  }
  return counts;
}

/**
 * ownerId 的**当前已折叠（不可见）的** produces/citation 相邻成员数量。
 * 在 `producesMembersOf`（双向、去重）的基础上，减去「当前投影图里已经
 * 可见」的成员。>0 才说明双击 owner 还能拉出新节点 → tooltip 该显示
 * 「双击展开节点」、toggleProduces 不弹 toast。
 *
 * 为什么不能只看原始边计数（`buildProducesMemberCounts`）：那计数不分可见
 * 性，对「相邻成员都已可见」的节点仍报 >0，于是：
 *  - sub_analysis2.txt 这类 Artifact：它的相邻 produces 成员（Code + Task
 *    scope）往往随别的展开早就可见了，原始计数=2 还在显「双击展开节点」
 *    tooltip，但双击其实拉不出新东西。
 *  - ResearchGoal：相邻 produces 成员=0（它的子节点走 next，本就可见），
 *    原始计数=0 已经不显 tooltip；但 toggleProduces 还会弹「无可展开子节点」
 *    toast——用户觉得「明明已展开子节点还弹无可展开」很怪。
 * 用可见性感知计数后两类都正确归 0：tooltip 不显、toast 不弹。
 *
 * `visibleIds` = 当前投影图（`projectToCanvas` 返回）的节点 id 集。双向
 * 相邻、排除 next/contains，与 `producesMembersOf` 一致。
 */
export function countFoldedProducesMembers(
  subgraph: MemorySubgraph,
  ownerId: string,
  visibleIds: ReadonlySet<string>,
): number {
  let folded = 0;
  for (const m of producesMembersOf(subgraph, ownerId)) {
    if (!visibleIds.has(m)) folded++;
  }
  return folded;
}

/**
 * 折叠 ownerId：仿 `collapseNode`，**只删 ownerId 亲手拉进来的子节点**
 * （记录在 `expandedNodeMap[ownerId]` 名下的），递归删它们各自名下的孙节点
 * （整棵）。这是「谁展开谁折叠」的边为中心模型——折叠一个节点不动它没拉
 * 进来的对端：若某节点是被**别的** owner 拉进来的（记在别的 owner 名下），
 * 折叠当前 owner 不碰它，它因还连着那个 owner 的边而留下。
 *
 * 返回需从可见集移除的节点 id 集（含 owner 名下直接子 + 递归的孙）。owner
 * 自身不在其中——owner 自身是否移除由调用方决定（owner 可能是主干节点，
 * 不该删；或被别的 owner 引用）。调用方还需从 `expandedNodeMap` 删 ownerId
 * 条目，并对 toRemove 的每个 id 从**所有** owner 的列表清引用（防御：按
 * `expandProducesOwner` 的「只记新节点」规则不会出现重复归属，但清引用是
 * 双保险，且能清掉孙节点在别的列表里的残留）。
 *
 * 与旧 `cascadeCollapseIds`（前向 produces BFS 全子树）的区别：旧版沿边关系
 * 走整棵前向子树，会把「被别的 owner 拉进来但前向可达当前 owner」的节点
 * 误删——过度收起。本函数只看 `expandedNodeMap` 的归属记录，不动图拓扑。
 */
export function collapseProducesOwner(
  expandedNodeMap: ReadonlyMap<string, ReadonlySet<string>>,
  ownerId: string,
): Set<string> {
  // **浅层折叠**（仿新版 Browser）：只删 ownerId 亲手拉进来的**直接子节点**，
  // 不递归删孙节点。例如 report2 名下记 Claim、Claim 名下记 Evidence；折叠
  // report2 只删 Claim，不碰 Evidence——Evidence 因还在别的 owner(Claim) 名下 /
  // 或连着别的边而留下（对齐用户在真实新版 Browser 上验证的行为：折叠 report2
  // 断 report2↔Claim 边、Evidence 节点不动）。HOWTO 称「新版与经典版逐字相同」
  // 在折叠这块不成立：经典版 collapseNode 递归删整棵，新版只删直接子。
  const toRemove = new Set<string>();
  const ownChildren = expandedNodeMap.get(ownerId);
  if (!ownChildren) return toRemove;
  for (const c of ownChildren) toRemove.add(c);
  return toRemove;
}

/**
 * 在 `mergeExpansions` 之后叠加主干投影。可见节点集 = 主干 ∪ produces 展开
 * 的 owner 自身及其名下子节点 ∪ scope 展开的 contains 子任务。砍掉既不在
 * 主干、也不在任何展开集里的节点 + 其悬挂边。
 *
 * 注意：不能砍 scope 展开带进来的子任务节点——它们不在主干上，但是
 * 用户主动双击 scope 展开出来的，必须保留。判断方法：scope 展开时，
 * `mergeExpansions` 把 expansion payload 合并进 mergedGraph，但其中只有
 * scope 的**直接 contains 成员**（child ToolCall，带 extra.parent_subtask_id
 * === scopeId）该随 scope 展开可见；produces 后代（Code/Artifact）不在
 * scope 名下、不在主干，留待用户逐层双击 ToolCall/Code 才进 expandedNodeMap
 * 展开（逐层：Task 展 ToolCall，ToolCall 展 Code，Code 展 Artifact）。
 *
 * 关键：scope 展开后，mergeExpansions 砍掉了 scope 的 surrogate produces
 * 边（真实链取代），而真实链的 produces 边在 child 名下、不在 scope 名下。
 * 所以光靠 expandedNodeMap 的归属救不回 scope 子任务（child ToolCall）。
 * 必须把 expandedScopes 的 contains 成员显式纳入 keep，才不会被砍掉。
 * `expandedScopes`/`expansionGraphs` 可选——不传则退回旧行为（纯函数测试
 * 用旧签名）。
 *
 * `expandedNodeMap` 是「谁展开谁折叠」模型：ownerId → 它**亲手拉进来**
 * 的子节点 id 集（仿 `expandedNodeMap`，一个新节点只记在第一个拉它进来的
 * owner 名下）。**不再驱动 keep**——keep 的 produces 部分改由 `appearedIds`
 * 推导。这里仍传入 expandedNodeMap 仅为 canvas 的 `producesExpanded` 判定
 * （记「谁展开过谁」）。一个节点若被别的 owner 拉进 appearedIds，折叠当前
 * owner 删其名下子节点时，它因还在别的 owner 名下/连着别的边而留下。
 */
export function projectToCanvas(
  mergedGraph: MemorySubgraph,
  mainChain: ReadonlySet<string>,
  expandedNodeMap: ReadonlyMap<string, ReadonlySet<string>>,
  appearedIds: ReadonlySet<string>,
  expandedScopes?: ReadonlySet<string>,
  expansionGraphs?: ReadonlyMap<string, MemorySubgraph>,
  /**
   * 链路高亮 overlay 临时保留的节点 id 集。链路态下把链路子图
   * （`chain.graph`）的节点 id 传入，让链上原本折成 `[+N]` 徽章的成员
   * 不被主干投影砍掉，随链展开点亮；链路关闭传 undefined 回骨架态。
   * 不影响 expandedNodeMap/appearedIds（不污染折叠状态，纯只读 keep）。
   * 不传则退回旧行为（纯函数测试用旧签名）。
   */
  extraKeepIds?: ReadonlySet<string>,
): MemorySubgraph {
  // 保留集：主干 ∪ appearedIds（「已出现节点集」）∪ scope 展开的 contains 成员。
  // 折叠只从该集移除被显式删除的**直接子**（浅层），孙辈留下——于是浅层折叠
  // report2 后 Claim 消失、Evidence 留着（它在 appearedIds，Claim 被删也不失保）。
  // 不再用「owner 自身 + 其 children」推导——那会让删 owner key 时连带失保孙，
  // 无法表达「节点加进来后脱离 owner 仍可见」的语义。expandedNodeMap 仍传入
  // （canvas 的 producesExpanded 判定用，记「谁展开过谁」），但不再驱动 keep。
  const keep = new Set<string>(mainChain);
  for (const id of appearedIds) keep.add(id);
  // SourceFile（用户上传的原料节点）默认常驻可见——它不在 next 主干上、
  // 连它的 feeds/input 边也不在 PRODUCES_EDGE_TYPES 的展开路径里，否则首次
  // 进图谱时上传文件节点会被主干投影砍掉，看不到"哪个上传文件喂给了哪段
  // 代码"。像主干锚点一样无条件 keep，不写 expandedNodeMap/appearedIds，
  // 因而不污染折叠状态、也不影响双击逐层展开的交互。
  for (const n of mergedGraph.nodes) {
    if (n.label === "SourceFile") keep.add(n.id);
  }
  // expandedNodeMap 不再驱动 keep——appearedIds 已含所有曾出现节点。owner
  // 若该可见（被别的 owner 拉进 appearedIds，或本就在主干），自然在 keep；
  // 折叠删 owner key 不影响其可见性，只影响它名下直接子的去留。
  // scope 展开只放行它的**直接 contains 成员**（child ToolCall）——即 expansion
  // payload 里 extra.parent_subtask_id === scopeId 的节点。produces 后代
  // （Code/Artifact）不在 scope 名下，留待用户双击 ToolCall/Code 走
  // expandedNodeMap 逐层展开（Task→ToolCall→Code→Artifact）。这样 scope
  // 双击不会一下子把整个子树摊开，而是逐层可见。
  if (expandedScopes && expansionGraphs) {
    for (const scopeId of expandedScopes) {
      const expansion = expansionGraphs.get(scopeId);
      if (!expansion) continue;
      for (const n of expansion.nodes) {
        if (typeof n.extra?.parent_subtask_id === "string"
          && n.extra.parent_subtask_id === scopeId) {
          keep.add(n.id);
        }
      }
    }
  }
  // 链路 overlay 临时保留：链路态下链上成员（含折叠徽章成员）随链点亮，
  // 不被主干投影砍掉。链路关闭时调用方传 undefined，回骨架态。只读并入 keep，
  // 不写 expandedNodeMap/appearedIds，故链路关闭后折叠状态恢复原样。
  if (extraKeepIds) {
    for (const id of extraKeepIds) keep.add(id);
  }
  const nodes = mergedGraph.nodes.filter((n) => keep.has(n.id));
  const edges = mergedGraph.edges.filter(
    (e) => keep.has(e.source) && keep.has(e.target),
  );
  return {
    ...mergedGraph,
    nodes,
    edges,
    total: nodes.length,
  };
}
