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

import type { PermissionAction, PermissionDescriptionRenderers } from "@sciencediscovery/schema";

/** The workspace an approval covers, as an adverbial: 会话工作区 / 子代理 X. */
function permissionWorkspace(subagentId: string | undefined): string {
  return subagentId ? `子代理 ${subagentId}` : "会话工作区";
}

/** 在会话工作区中 / 在子代理 X 中 / 在 build-01 上的会话工作区中. */
function permissionWhere(remoteHostAlias: string | undefined, subagentId: string | undefined): string {
  const workspace = permissionWorkspace(subagentId);
  return remoteHostAlias ? `在 ${remoteHostAlias} 上的${workspace}中` : `在${workspace}中`;
}

/**
 * The approval sentence, composed from the request's structured description
 * (#1305). A persisted request is replayed through whichever dictionary is in
 * force, so switching language never leaves a card in the language it was
 * created in. The canonical English sentence stays on the request itself.
 */
const PERMISSION_DESCRIPTIONS: PermissionDescriptionRenderers = {
  shell: ({ remoteHostAlias, subagentId }) => `${permissionWhere(remoteHostAlias, subagentId)}运行 Shell 脚本`,
  python: ({ remoteHostAlias, subagentId }) => `${permissionWhere(remoteHostAlias, subagentId)}运行 Python 代码`,
  language: ({ language, remoteHostAlias, subagentId }) => `${permissionWhere(remoteHostAlias, subagentId)}运行 ${language} 代码`,
  "file-copy": ({ fileCount }) => `在已授权的工作区之间复制 ${fileCount} 个选中的文件`,
  npu: ({ operation, subject, subagentId }) => `在${permissionWorkspace(subagentId)}中${operation === "run" ? "运行" : "取消"}主机 NPU 任务 ${subject}`,
  "direct-host": ({ account, command, cwd, runnerId, subagentId, target, workspaceRoot }) =>
    `直接在主机上执行：Runner ${runnerId}，目标 ${target}，账号 ${account}，工作区 ${workspaceRoot}，目录 ${cwd || "."}`
    + `${subagentId ? `，子代理 ${subagentId}` : ""}。不会隔离文件系统、进程或网络，主机凭据可能可被访问；`
    + `主机上的影响无法全部追踪或回滚。同类授权只覆盖本次 Agent 运行中的这条命令和这个范围，没有固定有效期。`
    + `批准不会执行命令。命令：\n${command}`,
  "specialist-runtime": ({ runtime, workspaceRoot }) =>
    `在 API 主机上直接运行 ${runtime}（${workspaceRoot}）。这会移除本任务的外层沙箱；平台工具仍各自需要授权。`,
  network: ({ hosts, purpose, runnerId }) =>
    `本次 Agent 运行允许 ${runnerId} 上的沙箱网络访问：${hosts.join("、")}。用途：${purpose}。`,
  environment: ({ environmentId, language, manager, name, operation, runnerId }) => {
    const runner = runnerId ? `（Runner ${runnerId}）` : "";
    switch (operation) {
      case "create": return `创建命名 ${language ?? ""} 环境 ${name ?? environmentId ?? ""}${runner}`;
      case "delete": return `删除命名环境 ${environmentId ?? ""}${runner}`;
      case "install": return `在命名环境 ${environmentId ?? ""} 中安装 ${manager ?? ""} 软件包${runner}`;
      case "setup": return `在所选 Runner 上初始化科研环境${runner}`;
      case "uninstall": return `从命名环境 ${environmentId ?? ""} 中卸载软件包${runner}`;
    }
  },
  "workspace-sync": ({ direction, paths, runnerId }) =>
    `${direction === "pull" ? `从 Runner ${runnerId} 拉取` : `推送至 Runner ${runnerId}`}：${paths.join("、")}`,
  "skill-publish": ({ proposalCount, subagentId }) =>
    subagentId
      ? `从子代理 ${subagentId} 发布 ${proposalCount} 个技能库提案`
      : `在本会话中发布 ${proposalCount} 个技能库提案`,
  "mcp-tool": ({ recovered, sourceId, toolId }) => `调用${recovered ? "修复后的 " : " "}MCP 工具 ${sourceId}/${toolId}`,
  "artifact-download": ({ name, path }) => `下载 ${name} 到工作区路径 ${path}`,
  "remote-job": ({ command, hostAlias, mode }) => `在 ${hostAlias} 上运行 ${mode.toUpperCase()} 任务：${command}`,
  web: ({ hostname, operation, query }) =>
    operation === "fetch" ? `获取 ${hostname ?? ""} 的公开网页内容` : `检索公开网络：“${query ?? ""}”`,
  "tool-call": ({ detail, toolName }) => {
    const call = `在本会话中运行${toolName ? `工具 ${toolName}` : "工具调用"}`;
    // 被批准调用的参数（命令或 JSON）原样显示，资源本身无法说明它们。
    return detail ? `${call}\n${detail}` : call;
  },
};

/** Engine reason strings that reach the UI; an unknown reason stays verbatim. */
const IDEA_RESEARCH_REASONS: Record<string, string> = {
  'Remaining token budget cannot fund the next stage': '剩余 token 预算不足以完成下一个阶段',
  'Candidate or node limit reached': '已达到候选或节点上限',
  'No active expandable direction remains': '没有仍可扩展的研究方向',
  'No new legal candidate fits the remaining tree limits': '没有符合剩余树限制的新候选',
  'Exploration round limit reached': '已达到探索轮次上限',
  'Paused by user': '用户已暂停',
  'Ended by user': '用户已结束',
  'Stopped by user': '用户已停止',
  'Service restarted; continue manually': '服务已重启，可手动继续',
};

/**
 * Every user-visible string, in one place — Simplified Chinese.
 *
 * This dictionary is also the shape of the interface: `Text` is `typeof ZH`,
 * so the English dictionary cannot grow or lose a key without the compiler
 * saying so. Wording is reviewable here without reading any JSX.
 */
/**
 * How long a run took, in the units a wait is actually felt in. Shared by the
 * finished span and the live clock on the folded line so the two never read
 * differently: an hour is where "72 分" stops being readable, and the seconds
 * are dropped there because by then they are noise.
 */
function runSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export const ZH = {
  configurationLegacy: {
    title: "启用连接器", awaiting: "等待确认", change: "修改", scope: "范围", session: "仅当前会话",
    continuation: "原任务", noTask: "没有已提交的任务", recorded: "服务器已记录任务续跑", serverOwned: "由服务器管理原任务续跑",
    enable: (name: string) => `启用 ${name}`, userReason: (name: string) => `你请求启用 ${name}。`, taskReason: (name: string) => `原任务需要使用 ${name}。`,
    confirm: "确认并启用", decline: "暂不配置", saving: "正在保存…", saved: "已保存", dismissed: "未配置", stale: "请求已过时",
    dismissedDetail: "本次请求没有启用此连接器。", staleDetail: "设置或原任务已发生变化，不能再应用此请求。",
    countdown: (seconds: number) => `此前已授权的自动配置将在 ${seconds} 秒后由服务器复核。`, due: "正在等待服务器复核此前已授权的自动配置。",
    waitRun: "请等待当前任务到达安全暂停点后再决定。", failed: "未能确认本次操作的结果。请刷新状态后再试。", refresh: "刷新状态",
  },
  researchPackage: {
    continueUnavailable: "此导入记录尚未完整恢复，暂不能继续聊天。请恢复缺失的服务后重新导入。", sourceUnavailable: "会话或所属项目已不存在。请刷新会话列表后重试。",
    projectDestination: "项目归属", noProject: "无项目", projectDestinationHint: "默认放入「会话」，也可以选择一个已有项目。",
    projectImport: (name: string) => `在「${name}」中导入会话`, messageMenu: "回复菜单", packageContents: "包含会话、工作区文件、产物及相关研究证据。",
    title: "科研证据包", import: "导入会话", export: "导出会话", continue: "继续聊天", branch: "创建新分支聊天", source: "返回来源会话",
    readOnly: "导入证据快照 · 只读。创建独立副本后，可使用已有材料继续研究。", copying: "正在复制研究记录，可切换会话…", failed: "操作失败",
    recalculating: "正在重算…",
    omissionsSummary: (count: number) => `未包含 ${count} 个工作区文件`, download: "下载", preparing: "正在后台准备证据包…", close: "关闭", copyMissing: "复制任务对应的会话或操作记录已不存在，已停止等待。请重新创建续聊。", copyPollingFailed: "暂时无法读取复制进度，已停止重试。请稍后刷新或重新操作。", legacyUnavailable: "本地服务暂时不可用，正在重试…", exportPollingFailed: "暂时无法读取导出进度，已停止重试。请稍后重新导出。", exportMissing: "导出任务已不存在，请重新导出。",
    exportDownloadStartTimeout: "等待证据包开始下载超时。请检查网络连接后重试。",
    exportDownloadStalled: "证据包下载长时间没有收到数据。请检查网络连接后重试。",
    necessary: "必要导出", recordsBytes: "记录数据", retryPreview: "重新计算大小", previewRetrying: "仍在计算大小…", pendingLong: "大小预览迟迟没有完成，可以重新计算，或先取消稍后再试。", detailsRaw: "技术细节", taskMissing: "导出任务已不存在，请重新导出。", taskExpired: "导出文件已过期，请重新导出。", taskRestarted: "服务重启时导出尚未完成，请重新导出。", complete: "完整导出", exportTypes: "选择导出类型", badgeConversation: "会话记录", badgeCurrentFiles: "当前文件与产物", badgeDependencies: "依赖证据", badgeFileVersions: "文件与产物版本", badgeHistory: "已有研究历史", selectAll: "全选", filesWithCount: (count: number) => `工作区文件（${count}）`, otherContent: "选择其他内容", readOnlyTitle: "当前为只读快照", readOnlyBadge: "只读", contextFrom: "上下文来自", dropHint: "拖拽或选择需导入的研究包", necessaryHint: "保留会话记录、当前文件与必要依赖", completeHint: "包含所有文件、历史版本和研究资料", graph: "包含完整科学记忆", estimate: "预计大小", estimateUncompressed: "未压缩估算", calculating: "正在计算范围与大小…", sizeLimit: (size: string) => `未压缩上限：${size}`, overLimit: (size: string, limit: string) => `当前选择未压缩为 ${size}，超过上限 ${limit}。请改用必要导出，或取消勾选最大的工作区文件。`, overLimitNecessaryOnly: "必要导出已经是最小范围：只有「仍要导出」或取消勾选工作区文件才能让它放下。", overLimitRisk: "仍要导出会把整个范围读入内存并压缩：可能耗时很久，也可能耗尽本机内存。", exportAnyway: "仍要导出", overLimitConfirmed: "已确认超限导出。该证据包会超过已标注的上限。", packageTooLarge: "该证据包超过此版本接受的体积上限。若由你导出，请用更小的范围重新导出；若由他人发送，请让对方用小一些的范围重新导出。", evidenceOnly: "证据包用于检查和继续研究；导入不会执行代码或恢复历史授权。", choose: "选择 .sdresearch 研究包", objects: "个内容对象", importOmissions: (count: number) => `未包含 ${count} 项`, omissionText: {
          family: { artifact: "产物", cas: "包内对象", evolve: "演化检索", review: "审阅记录", run: "任务运行", trajectory: "轨迹记录", version: "文件版本", workspace: "工作区文件" },
          hint: { artifact: "这个产物的某个版本没有随包携带。", cas: "包里引用的对象内容缺失。", evolve: "演化检索的候选树、评分或预算没有随包携带。", review: "审阅记录在打包时无法写入或读取。", run: "这次任务运行的记录不完整。", trajectory: "这次会话的轨迹条目读不出。", version: "文件历史版本的原始内容缺失。", workspace: "工作区文件的内容读不出或缺失。", unparsed: "包的清单里有这一条，但它不是可读文本。" },
          unrepresentable: "无法表示的值",
          unparsed: (raw: string) => `${raw}（不是可读文本）`,
        }, importHint: "恢复会话、文件和研究证据为只读快照。继续研究将创建独立的新会话。原始记录保留不变。", branchHint: "新分支保留所选回复及之前的对话与可恢复研究证据，不包含之后的内容；原会话保持不变。", reply: "分支起点", working: "正在处理…", startExport: "开始导出", cancelAction: "取消", chooseFile: "选择文件", reselect: "重新选择", confirmImport: "导入", exportSaving: "正在保存证据包…", exportSaved: "证据包已保存", exportSaveFailed: "保存证据包失败", exportCanceled: "已取消导出", openLocation: "打开文件位置", exportsInProgress: (count: number) => `${count} 个导出进行中`, retrySave: "重新保存", savedExports: "已保存的会话包",
  },
  /** 导出记录: the study packages this machine has saved, reachable again after
   *  the export dialog closed or the app restarted (#1154). */
  exportHistory: {
    title: "导出记录",
    description: "本机保存过的研究包，可从这里找回",
    empty: "还没有保存过研究包。",
    noMatch: "没有符合筛选条件的研究包。",
    unavailable: "导出记录只在桌面应用内可用。",
    searchPlaceholder: "搜索文件名或会话",
    allProjects: "全部项目",
    missing: "文件已被移动或删除",
    reveal: "打开文件位置",
    forget: "移除记录",
    revealMissing: "文件已被移动或删除，可以从记录里移除它。",
  },
  /** 会话管理: 归档把会话移出侧栏，这里就是它被移去的地方——打开是只读的，
   *  恢复让它回到活跃，彻底删除是这一页唯一不可撤销的动作。 */
  sessionManagement: {
    title: "会话管理",
    description: "已归档的会话，可恢复或彻底删除",
    empty: "没有已归档的会话。",
    noMatch: "没有符合筛选条件的会话。",
    loading: "正在读取已归档的会话…",
    unreachable: "有项目读取失败，这里的列表可能不完整。",
    searchPlaceholder: "搜索会话",
    allProjects: "全部项目",
    archivedAt: (when: string) => `归档于 ${when}`,
    readOnly: "归档期间只读：恢复后可以继续对话",
    open: "打开",
    restore: "恢复",
    remove: "彻底删除",
  },
  appName: "ScienceDiscovery",
  /** The BCP 47 tag the language calls itself, for `Intl` and `<html lang>`. */
  languageTag: "zh-CN",

  boot: {
    checking: "正在连接本地服务…",
    offlineTitle: "连不上本地服务",
    offlineBody: "没有收到本地服务的响应。请确认 ScienceDiscovery 已在运行，然后重试。",
    retry: "重试",
    noTokenTitle: "需要访问凭据",
    noTokenBody: "请把启动输出里的访问链接（结尾是 #token=…）完整粘贴到地址栏，或直接粘贴凭据。",
    tokenLabel: "访问凭据",
    tokenPlaceholder: "粘贴访问凭据",
    tokenSubmit: "进入",
    rejectedTitle: "凭据未被接受",
    rejectedBody: "本地服务拒绝了这份凭据。请从启动输出里重新复制完整的访问链接。",
    localConnected: "本地服务凭据已接受。",
  },

  login: {
    brandTitle: "提更好的问题，做更好的研究。",
    brandTagline: "在一个工作台里规划、执行并追溯科研工作——先送积分试跑，满意再谈投入。",
    benefitCredits: "首次登录赠送 500 积分",
    benefitNoCard: "不用绑卡、不用订阅，只送积分",
    benefitByok: "随时可切换到自己的模型端点",
    privacy: "使用华为账号登录。我们只保存账号标识、昵称，以及华为账号共享的邮箱（如有）。",
    title: "账号登录",
    subtitle: "使用华为账号登录成功后即可获得积分，并通过积分免费使用模型。点击下方登录按钮，将跳转至华为账号页面完成登录（本应用不会读取或保存华为账号的手机号）",
    huaweiButton: "使用华为账号登录",
    skipToModel: "暂不登录，配置自定义模型",
    entering: "正在进入工作台…",
    redirecting: "正在等待华为账号…",
    verifying: "正在确认登录状态…",
    errorTitle: "登录未完成",
    errorBody: "华为账号返回了错误，或账号服务未能验证这次登录。请重试。",
    accountServiceMissing:
      "本次构建未配置账号服务地址，华为账号登录暂不可用。请联系构建方设置 VITE_ACCOUNTS_API 后重新构建。",
    localTokenMissing: "登录已完成，但本机访问凭据未能签发。请确认本地服务已启动后重试，或退出登录。",
    retry: "重试",
    accountTab: "华为账号登录",
    modelTitle: "自定义模型配置",
    modelEnter: "保存并进入工作台",
  },

  account: {
    eyebrow: "华为账号",
    back: "返回会话",
    joined: (days: number) => `加入 ${days} 天`,
    emailReadonly: (email: string) => `邮箱 ${email}`,
    available: "可用积分",
    creditsUnit: "积分",
    tokenEstimate: "约合 Token",
    tokensUnit: "tokens",
    /** 大额 Token 数以万为单位：1.5万、2400万。英文表用 K/M/B，单位随语言变。 */
    tokenCount: (value: number) =>
      value >= 10_000 ? `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万` : Math.round(value).toLocaleString("zh-CN"),
    conversations: "可对话轮数",
    conversationsUnit: "轮",
    earned: "累计获得",
    spent: "累计消耗",
    todayEarned: "今日到账",
    rewardTitle: "今日奖励",
    rewardToday: "今日登录奖励已到账 +100 积分",
    rewardPending: "登录后自动到账",
    day: (day: number) => `第 ${day} 天`,
    rewardHint: (days: number) => `再连续 ${days} 天可获满 7 天奖励 +50 积分`,
    ledgerTitle: "积分流水与消耗明细",
    ledgerCapped: (rows: number) => `仅显示最近 ${rows} 条流水，更早的记录不再列出。`,
    filter: { all: "全部", earned: "获得", spent: "消耗" },
    ledgerEmpty: "还没有积分流水。",
    /** 流水的业务类型，键是服务端的 bizType；未知类型回退为原始值。 */
    biz: {
      REGISTER: "注册赠送",
      CHECKIN: "每日签到",
      BONUS: "累计签到奖励",
      LLM_USAGE: "模型调用",
      ADMIN: "人工调整",
      REFUND: "退还",
    },
    afterBalance: (balance: string) => `余额 ${balance}`,
    perPage: "每页",
    perPageUnit: "条",
    pageCurrent: (page: number) => `第 ${page} 页`,
    pageOf: (page: number, total: number) => `第 ${page} / ${total} 页`,
    prevPage: "上一页",
    nextPage: "下一页",
    jumpTo: "跳至",
    jumpUnit: "页",
    jump: "跳转",
    model: "模型",
    input: "输入",
    cached: "缓存",
    output: "输出",
    latency: "耗时",
    tokensTotal: "Token 合计",
    usageTitle: "近 5 天用量",
    calls5: (count: number) => `${count} 次调用`,
    spent5: (credits: string) => `消耗 ${credits} 积分`,
    tokens5: (tokens: string) => `${tokens} tokens`,
    usageFoot: (average: string, model: string) => `平均每次消耗 ${average} 积分 · 最常用模型 ${model}`,
    devicesTitle: "登录设备管理",
    currentDevice: "当前",
    signedInAt: (time: string) => `登录时间 ${time}`,
    revokeDevice: "退出",
    deviceRevoked: "已退出该设备",
    deviceRevokeFailed: "退出设备失败，请重试",
    profileTitle: "昵称与账号",
    displayName: "昵称",
    nameHint: "1–24 个字符，保存后抽屉与用户按钮同步更新。",
    nameInvalid: "昵称需为 1–24 个字符",
    email: "邮箱（只读）",
    emailHint: "邮箱来自华为账号，不能在应用内修改。",
    save: "保存昵称",
    saveShort: "保存",
    editName: "编辑昵称",
    saved: "昵称已保存",
    saveFailed: "保存失败，请重试",
    rulesTitle: "积分规则",
    rulesBody: "首次登录赠送 500 积分，每日首次登录赠送 100 积分，累计签到每满 7 天额外赠送 50 积分。1 积分约合 4 万 token 的展示估值，实际消耗以模型用量结算为准。",
    signOut: "退出登录",
    signOutTitle: "确认退出华为账号",
    signOutBody: "退出后，华为账号积分模型将不可用",
    loadFailed: "账号信息加载失败，请稍后重试。",
  },

  /** The narrow icon rail down the left edge. */
  rail: {
    task: "会话",
    settings: "设置",
    user: "用户",
  },
  sidebar: {
    title: "科研会话",
    githubStar: "在 GitHub 上加星",
    newTask: "新建会话",
    project: "项目",
    /** The standalone-conversation section, and the title the app shows
     *  wherever a Session outside a Project has to name one. */
    recent: "会话",
    noRecent: "还没有会话",
    noProjects: "还没有项目",
    newProject: "新建项目",
    projectName: "项目名称",
    /** Said under the name field when another Project already has that name;
     *  the service refuses the same name with a 409. */
    projectNameTaken: (name: string) => `已存在同名项目「${name}」，请换一个名称`,
    /** The `+` on a Project fold; the name is in it because a row of several
     *  identical buttons is not distinguishable to a screen reader. */
    newSessionInProject: (name: string) => `在「${name}」中新建会话`,
    /** The `⋯` on a Project fold: rename and delete, the same two the session
     *  row offers. */
    projectMenu: "项目菜单",
    noTasks: "暂无会话",
    /** The fold control's label: how many older Sessions pressing it reveals,
     *  computed from the list itself so the tail never reads as deleted. */
    showMore: (count: number) => `显示更早的 ${count} 个会话`,
    /** The rule a folded Project states above its page: the newest N are shown. */
    pageRule: (count: number) => `最近 ${count} 个`,
    collapseSidebar: "收起侧栏",
    expandSidebar: "显示侧栏",
    /** Shown as the tooltip on a session name, for the gesture nothing else
     *  announces. The same rename is in the row's `⋯` menu. */
    renameHint: "双击改名",
  },

  sessionBar: {
    workspaceToggle: "工作区面板",
    sessionMenu: "会话菜单",
    sessionTitle: "会话名称",
    renameHint: "双击改名",
    /** Stands in for a Session the server created without a title. */
    untitled: "未命名会话",
  },

  menu: {
    rename: "重命名",
    delete: "删除",
    archive: "归档",
    restore: "恢复",
    confirm: "确认",
    cancel: "取消",
  },

  composer: {
    placeholder: "需要帮你做些什么？输入“/”快速引用技能及指令",
    /** After a design command is seeded the composer is no longer waiting for
     *  any request: the only useful next line is the goal itself. */
    evolvePlaceholder: "请描述你想要优化的对象和评估标准",
    /** Shown under an Idea Tree token, which asks for a research task rather
     *  than a design goal. */
    ideaTreePlaceholder: "请描述要研究的问题和判断依据",
    send: "发送",
    stop: "停止",
    /** 设计命令上的 ✕：对话框给的是建议，改主意的人要能把它去掉再说话。 */
    clearCommand: "移除指令",
    modelSelect: "选择模型",
    addCustomModel: "添加自定义模型",
    pillLocked: "这一轮跑完才能切换模型",
    stopHint: "关闭页面或刷新不会停止运行，必须在这里显式停止。",
    uploadFile: "上传文件",
    sessionSettings: "会话设置",
    /** 会话设置最上面的一项：进入程序演进。 */
    evolveExperiment: "程序演进实验",
    ideaTree: "idea-tree",
    experts: "专家",
    expertsNone: "无",
    expertsHint: "为此对话绑定一位个人专家。",
    expertsDisabled: "已停用",
    boundExpertDisabledHint: "该专家已从新选择中停用，但当前会话仍保留绑定。选择“无”后，后续轮次不再使用它。",
    expertsSearch: "请输入关键字搜索",
    expertsEmpty: "没有匹配的专家。",
    expertsLoading: "正在读取专家…",
    /** The `/` palette's name, for its listbox role. */
    skillsPalette: "选择技能",
    permission: "请求批准",
    permissionMode: "权限模式",
    permissionAskDesc: "编辑外部文件和使用互联网时始终询问",
    permissionFull: "完全访问",
    permissionFullDesc: "可不受限制地访问互联网和您电脑上的任何文件",
    permissionLocked: "这一轮跑完才能切换权限",
    attachHint: (limit?: string) => limit === undefined
      ? "放进本次会话的工作区，智能体就能读到。也可以直接把文件拖进界面。"
      : `放进本次会话的工作区，智能体就能读到。单个文件最大 ${limit}。也可以直接把文件拖进界面。`,
    attachArchived: "这个会话已经归档，不能再写入。取消归档后才能上传。",
    /** Composer placeholder while the JiuwenSwarm cluster starts. */
    jwBlocked: "智能体集群正在启动，就绪后即可对话…",
  },

  ideaTreeOverride: {
    title: "idea-tree 参数",
    hint: "确认后把这套参数用于当前会话，并在输入框放好 Idea Tree 命令；补全研究任务后发送即可。单次修改只用于当前会话，不影响全局默认；只有点「覆盖全局设置」才会改全局默认。",
    template: "研究模板",
    templateGeneral: "通用科学假设",
    templateWater: "水处理材料",
    intensity: "探索强度",
    quick: "快速",
    standard: "标准",
    deep: "深入",
    direction: "评分方向",
    maximize: "最大化",
    minimize: "最小化",
    maxDepth: "最大深度",
    maxNodes: "最大节点数",
    saveSession: "确认",
    /** Beside a field: the deployment value it inherits, so the reader can see
     *  what 确认 would write and what releasing a pin means. */
    globalValue: (value: string) => `全局：${value}`,
    /** Badge on a field whose draft differs from the deployment value. */
    overridden: "已覆盖",
    pinned: "本次会话已固定部分参数；其余字段仍跟随全局设置。",
    saveGlobal: "覆盖全局设置",
    cancel: "取消",
    loading: "正在读取…",
    savedSession: "已用于本次会话，之后发起的研究会用这套参数",
    confirmSend: "确认",
    savedGlobal: "已写入全局设置",
    unchanged: "没有需要写入全局的改动。",
    noSession: "打开一个会话后，才能只给本次会话改参数。",
  },
  /** Reviewer Specialist：会话设置里的开关，和产物审查在对话里的那张卡。 */
  reviewer: {
    title: "审查",
    settings: "自动审阅",
    unavailable: "审查专家已关闭，此会话的自动审阅不会生效。",
    level: "审查档位",
    /** 显示在档位行上：自动审阅关着时它并没有失效，立即审查仍会用它。 */
    levelManualHint: "自动审阅已关闭；立即审查仍会使用这个档位。",
    levelQuickDesc: "确定性检查：结构、引用格式、交付完整性。",
    levelDeepDesc: "在快速检查之上，逐条核对来源与计算证据。",
    running: "正在审查…",
    /** The stage the coordinator is in, when it says. It is what tells a
     *  reader that a long Deep review is working rather than stuck. */
    phase: {
      quick: "快速检查中",
      preparing: "准备审查…",
      computation: "核对计算证据",
      citation: "核对引用",
    } as Record<string, string>,
    summaryPass: "未发现问题",
    summaryFindings: (count: number) => `${count} 个问题`,
    /** A warning is not a revision request; its row and badge say 提醒. */
    summaryWarnings: (count: number) => `${count} 个提醒`,
    summaryFindingsAndWarnings: (critical: number, warnings: number) =>
      `${critical} 个问题 · ${warnings} 个提醒`,
    summaryContradicted: "矛盾",
    summaryPartlySupported: "部分支持",
    summaryIncomplete: "交付不完整",
    summaryUnverified: "未验证交付",
    summaryFailed: "审查失败",
    summarySkipped: "已跳过审查",
    /** Nothing was raised, but the review itself said part of the claim was
     *  never examined. "未发现问题" alone would read as a pass. */
    summaryPartial: (count: number) => `未发现问题，但有 ${count} 项未检查`,
    checks: (count: number) => `${count} 项检查`,
    /** One checkpoint can cover several artifacts; when their verdicts differ,
     *  the header's worst-of phrase would hide the clean ones. */
    outcomeCounts: (passed: number, attention: number) => `${passed} 通过 · ${attention} 需处理`,
    checkNames: {
      structure: "结构",
      citation: "引用",
      computation: "计算",
      completeness: "完整性",
    } as Record<string, string>,
    /** What a category means, for the label above each claim. The label is one
     *  word ("计算"), which is not enough to know what was compared with what. */
    labelTips: {
      structure: "结构：核对产物的字段与格式是否完整、来源信息是否齐全，不判断内容对错。",
      citation: "引用：核对引文标识符能否识别、格式是否完整；不核实文献是否支持结论。",
      computation: "计算：把报告里的数值与证据、数据逐项比对，检查数字与统计口径是否一致。",
      completeness: "完整性：按本次任务声明的交付清单，检查应交付的文件是否都在、是否为空白。",
      semantics: "语义：深度审查读取引用的文献原文，判断结论是否有出处支撑；只有深度审查会做。",
      other: "通用发现：不属于某一类具体检查，是审查过程中记录的问题。",
      gaps: "未检查：这次审查没有做这一项，原因见下方；未检查不等于通过。",
      source: "来源核验：把一条结论与来源原文对照，给出支持、部分支持、矛盾或无结论。",
    } as Record<"structure" | "citation" | "computation" | "completeness" | "semantics"
      | "other" | "gaps" | "source", string>,
    checkPass: (name: string) => `${name}检查通过`,
    passBody: "这一项没有发现问题。",
    finding: "问题",
    warning: "提醒",
    badgePass: "通过",
    /** For a check that ran but could not conclude, or a delivery verdict no brief declared. */
    badgeUnconfirmed: "未确认",
    deepSemantic: "语义",
    source: "来源",
    gaps: "未检查",
    gapChecks: {
      claim_support: "主张与来源的对应",
      citation_identity: "引用身份",
      computation: "计算",
    } as Record<string, string>,
    /** What the unperformed check would have covered, in the card's language.
     *  The server's own reason is an English template and is only the fallback
     *  for a check this map does not know. */
    gapBodies: {
      claim_support: "这次审查没有核对结论有没有来源支撑。要核对请用深度审查。",
      citation_identity: "这次审查没有核对文献身份（作者、期刊、年份）。",
      computation: "这次审查没有核对数字与计算依据。",
    } as Record<string, string>,
    /** The claim-support gap as a Deep review leaves it. Asking the reader to
     *  run a Deep review again would contradict the level they just chose. */
    deepGapBodies: {
      inconclusive: "深度审查已经尝试核对结论与来源，但没能作出判断（可能缺少足够的原文，或读到的内容无法明确支持或否定结论），所以这一项仍算未检查。这不代表报告有问题。",
      noComparison: "深度审查没有找到可与原文比对的结论，所以这一项仍算未检查。",
    },
    gapBodyUnknown: "这次审查没有执行这一项。",
    /** A citation-format-only Quick pass did not look at claim support. */
    citationOnlyNote: "本次只核对引用格式，未检查结论支撑。",
    /** Why a checkpoint produced nothing, by the server's reason code. */
    skipReasons: {
      specialist_disabled: "审查专家已关闭，本次没有产生审查结论。",
      automatic_review_disabled: "此会话已关闭自动审阅，本次没有产生审查结论。",
    } as Record<string, string>,
    skipUnknown: "本次没有产生审查结论。",
    stale: "产物已有新版本，这次审查仅作历史记录。",
    outdated: "（已过期）",
    rerun: "重新审查",
    rerunQueued: "已加入审查队列。",
    /** Ask for a review of the Session's current report-shaped artifacts
     *  without waiting for a new version to make the old verdict stale. */
    runNow: "立即审查",
    stopRun: "停止审查",
    runStarted: "已开始审查。",
    runStopped: "已停止审查。",
    noCheckpoint: "没有可重新审查的检查点。",
    reused: "复用上次相同版本的结论",
    completeness: {
      complete: "交付完整",
      incomplete: "交付不完整",
      unconfirmed: "未声明交付清单",
      sourceBrief: "依据本次任务声明的交付清单。",
      sourceSession: "本次任务没有声明，按会话内已有声明核对。",
      sourceNone: "没有找到可对照的交付声明，因此无法确认。",
      missing: "缺失",
      empty: "空文件",
    },
    assessments: {
      SUPPORTED: "支持",
      PARTIALLY_SUPPORTED: "部分支持",
      CONTRADICTED: "矛盾",
      INCONCLUSIVE: "无结论",
    } as Record<string, string>,
    progress: (completed: number, total: number) => `${completed}/${total}`,
    queued: (count: number) => `排队 ${count}`,
    /** A bounded passage in a locked source; "定位" and evidence levels are
     *  internal vocabulary, so the card says what was found instead. */
    locators: (count: number) => `${count} 处来源材料`,
    sourceInconclusiveWith: (count: number) => `找到 ${count} 处来源材料，但还不足以判断这条结论是否成立。`,
    sourceInconclusiveNone: "没有找到可用于判断这条结论的来源材料。",
    failedDetail: "审查过程报告了错误。",
    empty: "这个检查点没有产生审查记录。",
    noReviews: "还没有审查记录。",
    tab: "审查",
    levelName: (level: string): string => (level === "quick" ? "快速" : "深度"),
    levelPill: (level: string): string => (level === "quick" ? "快速" : "深度"),
    /** The pill only names the level; the tip carries what the name claims.
     *  The two levels differ in whether the cited source text is read. */
    levelTip: (level: string): string => (level !== "quick"
      ? "深度审查：在快速检查之外，读取引用的文献原文和证据，逐条核对结论与来源是否一致。"
      : "快速审查：只在本机做确定性的结构、引用格式和交付完整性检查，不读取文献原文。"),
  },

  /** The bottom-right banner while the JiuwenSwarm cluster is still starting
   *  (the shell bridge pushes progress; this is the idle wording). */
  jiuwen: {
    starting: "智能体集群启动中",
    preparing: "正在初始化…",
  },

  /** Getting files into the workspace: the composer's button, and the overlay
   *  the whole window turns into while a file is being dragged over it. */
  upload: {
    dropTitle: "松开即上传",
    dropBody: (limit?: string) => limit === undefined
      ? "文件会放进工作区，智能体就能读到。"
      : `文件会放进工作区，智能体就能读到。单个文件最大 ${limit}。`,
    archived: "这个会话已经归档，不能再写入。",
    readOnly: "这个会话是只读的，不能再写入。",
    /** Stands in for the size when the service reports no per-file limit. */
    unlimited: "不限",
    busy: "上传中…",
    tooLarge: (name: string, limit: string) => `${name} 超过 ${limit}，没有上传。`,
    tooMany: (max: number) => `单次对话最多上传${max}个附件。`,
    failed: (name: string, reason: string) => `${name}：${reason}`,
  },

  /** The cards the composer holds: one per file, from the moment it is chosen
   *  until the message that carries it is sent. */
  attachment: {
    uploading: "上传中…",
    failed: "上传失败",
    retry: "重试",
    remove: (name: string) => `移除 ${name}`,
    delete: "删除",
    clear: "清空附件",
    /** The line under the name once the upload landed. */
    detail: (type: string, size: string) => (type === "" ? size : `${type} ${size}`),
    tray: "已选择的附件",
  },

  conversation: {
    configurationRefreshFailed: "配置请求未能刷新。已显示的状态可能已过时，请重试后再确认。",
    retryConfiguration: "重试",
    copyAnswer: "复制回答",
    usage: {
      label: "用量", heading: "本轮用量", models: "模型", input: "输入", output: "输出",
      cacheRead: "缓存读取", cacheWrite: "缓存写入", reasoning: "推理",
      unreported: "未上报", incomplete: "仅包含已上报用量，实际用量可能更高。",
      loading: "正在读取用量…", failed: "用量读取失败。", retry: "重试",
    },
    copied: "已复制",
    /** The system-notice kinds the transcript can carry. */
    notices: {
      timeout_notice: "超时",
      configuration_notice: "配置更新",
      wake_notice: "中断恢复",
    } as Record<string, string>,
    /** Fills in a cancellation whose reason the stream did not carry. */
    cancelledReason: "运行已取消",
    /** Explains an automatic wake that follows an interrupted run, so the
     *  second run in the transcript is not a silent duplicate. */
    interruptedResume: (attempt: number) => `上一轮未到达完成状态，已自动继续会话（第 ${attempt} 次尝试）。本轮只报告中断与后台通知，不会重跑上一轮的任务；中断原因见运行记录，如需继续请明确告知。`,
    interruptedRun: (runId: string) => `被中断的运行：${runId}（仍标记为已中断）`,
    thinking: "思考过程",
    thinkingSteps: (count: number) => `${count} 步`,
    /** The folded line standing in for a run that has not finished yet. */
    thinkingNow: "正在规划下一步",
    /** What the live line says while a tool is still running: the name is the
     *  only thing on screen that says which part of the work is taking so
     *  long. */
    workingTool: (name: string) => `正在运行 ${name}`,
    /** The same, for a child agent. The task is the child's own wording, taken
     *  from the snapshot the transcript already holds. */
    workingSubagent: (task: string) => `子代理正在处理：${task}`,
    /**
     * The folded line once the run is over. Minutes and seconds are the units a
     * wait is actually felt in; an hour is where "72 分" stops being readable,
     * and the seconds are dropped there because by then they are noise.
     */
    elapsed: (ms: number) => `用时 ${runSpan(ms)}`,
    /** The same span while the run is still going. A long run that reports no
     *  clock at all is indistinguishable from a stuck one, so the line keeps
     *  counting until the final span replaces it. */
    elapsedNow: (ms: number) => `已用 ${runSpan(ms)}`,
    expand: "▸ 展开",
    collapse: "▼ 收起",
    running: "生成中",
    queued: "排队中",
    blocked: "等待授权",
    completed: "已完成",
    failed: "运行失败",
    cancelled: "已取消",
    interrupted: "已中断",
    truncatedThinking: "思考过程较长，这里是其中一部分。",
    truncatedBody: "内容较长，这里是其中一部分。",
    droppedEvents: (count: number) => `有 ${count} 条更早的事件未能重放，以下是可恢复的部分。`,
    unknownEvents: (count: number) => `有 ${count} 个本版本不认识的事件被跳过。`,
    /** 运行中发来的、读不出来的更新：运行本身继续了，但这一轮可能缺一段。
     *  故意用日常说法，不向用户暴露协议或格式名词。 */
    malformedFrames: (count: number) => `有 ${count} 条更新无法读取，已跳过。`,
    streamEnded: "连接已结束，运行状态未知。刷新可重新获取。",
    emptyTurn: "这一轮没有产出文本。",
    toolCall: "工具调用",
    toolRunning: "工具正在运行…",
    loadingResult: "正在加载完整结果…",
    noOutput: "工具已完成，但没有输出。",
    toolInput: "输入",
    toolOutput: "输出",
    toolError: "错误",
    openInPanel: "在右侧打开",
    toolCompleted: (name: string) => `已调用 ${name}`,
    toolFailed: (name: string) => `调用失败：${name}`,
    inputTruncated: "输入已被保留策略截断。",
    outputTruncated: "输出已被保留策略截断。",
    authorized: "已授权",
    /** The substream read failed — the trace is still shown, only its body is
     *  missing. Distinct from "the tool produced nothing". */
    resultUnavailable: "结果暂时读取不到。",
    /** The folded card above a question, and the list it opens. */
    uploads: {
      more: (count: number) => `另外 ${count} 个文件`,
      rest: "另外上传的文件",
    },
  },

  /** What one assistant turn produced, under the answer that produced it (#1252). */
  turnArtifacts: {
    title: "本轮产物",
    updated: "已更新",
    more: (count: number) => `还有 ${count} 个`,
    openPanel: "打开产物面板",
    version: (value: number) => `v${value}`,
    kinds: {
      dataset: "数据集", figure: "图表", html: "网页", json: "JSON", latex: "LaTeX",
      markdown: "文档", notebook: "笔记本", other: "文件", report: "报告", structure: "结构",
    },
  },
  /** One delegated subagent. It is named by what it was asked to do, never by a
   *  role or a persona: the transcript shows a line, and the right panel shows
   *  the work. */
  subagent: {
    lineLabel: "Subagent",
    status: {
      running: "执行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      timed_out: "已超时",
    },
    /** The right panel's subagent mode. */
    detail: "执行详情",
    output: "输出",
    task: "任务",
    inputFiles: "输入文件",
    emptySteps: "这个 subagent 还没有留下可展示的执行记录。",
    loading: "正在加载执行记录…",
    stale: "执行记录已停止刷新，当前显示的内容可能滞后。",
    thinking: "思考",
    tool: "工具",
    turns: (count: number) => `${count} 轮`,
    tokens: (count: number) => `${count} tokens`,
    failedTitle: "执行失败",
    timedOutTitle: "执行超时",
    cancelledTitle: "执行已取消",
  },

  /** The welcome page a session starts on: the wordmark, the three ways in,
   *  and the starter prompts behind each of them. */
  landing: {
    tagline: "科学探索 更高效",
    placeholder: "有什么需要我帮忙的…",
    /** The ✕ on the category chip inside the composer. */
    clearCategory: "取消分类",
    /** The strip's folder item while no Project is chosen — the invitation
     *  the chip shows in place of a name. */
    projectDirectory: "选择项目",
    /** The strip's project reads as a label but is a button; this is what it
     *  announces, since the name alone does not say it opens anything. */
    chooseProject: "选择项目",
    /** The entry that files the next conversation outside every Project. */
    noProject: "不在任何项目中",
    noProjectNote: "这个会话会出现在「会话」里",
    categories: {
      research: "文献调研",
      experiment: "实验设计",
      analysis: "数据分析",
    },
    /** Each category opens its own row; a topic drops its prompt into the
     *  composer instead of sending it, so it stays editable. */
    topics: {
      research: [
        { label: "研究现状综述", prompt: "请检索并综述近三年水体中微塑料检测方法的研究现状，列出主要技术路线、代表工作和仍未解决的问题。" },
        { label: "关键技术调研", prompt: "请调研天然产物提取的关键技术（如超声辅助提取、超临界 CO₂ 萃取），比较它们的适用条件、优势与局限，并给出代表性文献。" },
        { label: "前沿论文追踪", prompt: "请找出植物源天然抗氧化剂（如茶多酚、花青素）最近发表的重要论文，按主题归类，并说明每篇的核心贡献。" },
        { label: "竞品技术分析", prompt: "请分析益生菌制剂领域主要团队或产品的技术路线，比较它们的差异与取舍。" },
      ],
      experiment: [
        { label: "对照实验方案设计", prompt: "请帮我设计一套细胞增殖抑制的对照实验方案，说明实验组、对照组、变量控制、重复次数和评价指标。" },
        { label: "抗氧化实验设计", prompt: "请帮我设计一套检测茶多酚清除自由基能力的实验方案，说明需要的试剂与仪器、样品怎么分组、操作步骤和评价指标。" },
      ],
      analysis: [
        { label: "蛋白质组学分析", prompt: "请帮我梳理一套从质谱原始文件到差异蛋白清单的蛋白质组学分析流程，说明每一步的输入、常用工具和需要留意的质量控制点。" },
        { label: "单细胞测序分析", prompt: "请帮我规划单细胞测序数据的分析流程，包括质控、聚类、细胞注释和差异表达。" },
      ],
    },
  },

  /** The first-run guide over the task page: three cards, one per part a new
   *  user has to find. It is read once and can be replayed from 设置 › 通用. */
  guide: {
    label: "新手引导",
    step: (index: number, total: number) => `第 ${index} / ${total} 步`,
    skip: "跳过",
    back: "上一步",
    next: "下一步",
    done: "开始使用",
    steps: {
      composer: {
        title: "对话框",
        body: "在中间的输入框里写研究需求，按 Enter 发送。左边的 + 可以上传文件，右边的下拉可以选择模型和权限模式，输入 / 可以直接引用技能和指令。第一句话发出去，这里就变成一段对话。",
      },
      settings: {
        title: "设置",
        body: "左侧窄栏里的「设置」打开配置面板：模型、技能、MCP 服务器、专家和网络都在这里，改完立即生效，不需要保存。",
      },
      panel: {
        title: "右侧栏",
        body: "右侧的工作区面板列出这次会话产生的产物和文件，点开即可预览；拖动它左边的分隔线可以调整宽度，顶部的按钮可以收起。",
      },
    },
  },

  /** 科学记忆：最终报告里的引用，以及点开后那张写着“它是什么、从哪来”
   *  的卡片。这里刻意没有图谱——一条链就是一段有先后顺序的故事。 */
  memory: {
    title: "科学记忆",
    loading: "正在读取科学记忆…",
    closeDialog: "关闭",
    openChip: "查看这条引用的详情与溯源",
    openSettings: "打开科学记忆设置",
    notFoundTitle: "没有找到这条记忆",
    notFoundBody: "记忆里没有这条记录。它可能已被删除，或记忆服务当前不可用。",
    disabledTitle: "科学记忆没有开启",
    disabledBody: "在「设置 → 科学记忆」里开启后，报告的引用就能展开成证据与产物。",
    unreachableTitle: "暂时读不到科学记忆",
    unreachableBody: "记忆服务没有响应。稍后再试一次。",
    errorTitle: "读取失败",
    retry: "重试",
    previewTab: "预览",
    provenanceTab: "溯源",
    contentLabel: "证据内容",
    sourceExcerpt: "来源摘录",
    chipLabels: {
      evidence: "证据",
      artifact: "产物",
      sourcefile: "文件",
      dbrecord: "数据记录",
      session: "会话",
      skill: "技能",
    },
    status: {
      healthy: "运行正常",
      degraded: "连接失败",
      checking: "检查中",
      unknown: "状态未知",
      recheck: "重新检查",
    },
    field: {
      evidenceType: "证据类型",
      locator: "定位",
      confidence: "置信度",
      source: "来源",
      recordedAt: "记录时间",
      name: "名称",
      version: "版本",
      mediaType: "媒体类型",
      path: "路径",
      session: "会话",
      hash: "内容哈希",
    },
    version: (version: number) => `v${version}`,
    nodeLabels: {
      Artifact: "产物",
      Claim: "主张",
      Code: "代码",
      DbRecord: "数据库记录",
      Evidence: "证据",
      Paper: "文献",
      ResearchGoal: "研究目标",
      SearchCell: "搜索单元",
      SearchNode: "候选方案",
      SearchRun: "进化搜索",
      SourceFile: "上传文件",
      Task: "任务",
      ToolCall: "任务步骤",
      WebPage: "网页",
    },
    provenance: {
      loading: "正在读取溯源…",
      error: "溯源没有读出来。",
      retry: "重试",
      noAbstract: "未记录摘要。",
      sourcesEmpty: "没有记录到来源文献、文件或网页。",
    },
    /** 证据的来源文件沿用旧版 UI 的内联预览：PDF 用 iframe、图片直接显示、
     *  其余类型给下载链接。 */
    evidenceSource: {
      loadingFile: "正在读取文件预览…",
      fileMissing: (name: string) => `找不到文件 ${name}。`,
      fileFailed: "文件预览读取失败。",
      downloadFile: (name: string) => `下载 ${name}`,
      unknownType: "未知类型",
    },
    openArtifactFailed: "打不开这条产物。",
    artifactMissing: "产物面板里找不到这条产物。",
    /** Artifact 的弹窗沿用旧版 UI：头部是版本与下载，正文分「预览 / 溯源」
     *  两个页签。 */
    artifactDialog: {
      previewTab: "预览",
      versionLabel: "版本",
      versionOf: (version: number, total: number) => `第 ${version} 版 / 共 ${total} 版`,
      updatedInSession: (session: string) => `更新于会话 ${session}`,
      versionSource: (session: string) => `来源：${session}`,
      deletedSession: "已删除会话",
      download: "下载当前版本",
      downloadFailed: "无法下载产物",
      // The dialog is on screen from the press; this is what its body says
      // until the version's bytes arrive.
      loading: "正在打开产物…",
      versionAria: "产物版本",
    },
    /** Artifact 的溯源沿用旧版 UI 的产物溯源页：上游文件、跑了什么
     *  代码、执行日志，以及当时的受管环境。 */
    artifactProvenance: {
      dependencies: "上游文件",
      code: "代码",
      downloadScript: "下载脚本",
      execution: "执行日志",
      exitCode: (code: number | null) => `退出码 ${code ?? "不可用"}`,
      workingDirectory: "工作目录",
      unavailable: "不可用",
      stdoutEmpty: "stdout：空",
      environment: "受管软件包环境",
      noPackages: "未记录软件包",
      sourceSessionDeleted: "来源会话已被删除。产物内容和版本历史仍然保留，但会话执行详情不可用。",
      processEnvironment: (count: number) => `进程环境（${count} 个变量）`,
      processEnvironmentEmpty: "未记录环境变量。",
      processEnvironmentUnavailable: "进程环境不可用（本次运行未记录）。",
    },
  },

  permission: {
    required: "需要权限",
    allowOnce: "仅允许一次",
    allowMatching: "允许同类操作",
    deny: "拒绝",
    details: "详情",
    action: "操作",
    resource: "资源",
    requested: "请求时间",
    decision: "决定",
    decided: "决定时间",
    execution: "执行",
    toolCall: "工具调用",
    /** The action as a noun phrase, for a request whose producer sent no
     *  structured description (a request recorded before #1305, or one from a
     *  client that supplies only `summary`). */
    actions: {
      artifact_download: "下载产物",
      code: "运行本地代码",
      connector: "使用连接器",
      direct_code: "在主机上直接执行（无沙箱）",
      directory: "访问目录",
      host: "连接主机",
      remote_job: "运行远程任务",
      sandbox_network: "沙箱网络访问",
    } satisfies Record<PermissionAction, string>,
    description: PERMISSION_DESCRIPTIONS,
  },

  wizard: {
    title: "选择一个模型提供方",
    sub: "选择提供 AI 模型服务的平台，后续将配置对应的模型及访问凭证。",
    art: {
      title: "AI Workbench",
      sub: "Finding better solutions",
    },
    workspace: {
      title: "配置你的研究工作区",
      sub: "产物、中间结果与日志都会落在这个目录下，便于统一管理。",
      label: "工作区目录",
      placeholder: "选择或输入目录路径",
      browse: "浏览目录",
      useDefault: "使用默认位置",
      note: "这一项只记录你选择的位置：实际数据目录由外壳在启动时确定，改这里不会搬动已有数据。",
      check: {
        writable: "✓ 目录可写",
        notWritable: "✗ 目录不可写（请检查权限或杀毒软件）",
        freeUnknown: "⚠ 无法读取磁盘剩余空间",
        free: (size: string) => `✓ 磁盘剩余 ${size}（建议 ≥5GB）`,
        freeLow: (size: string) => `✗ 磁盘剩余 ${size}，不足 5GB`,
      },
      skip: "跳过，用默认值",
      next: "下一步",
    },
    boot: {
      title: "正在准备工作环境",
      sub: "首次启动需要准备运行时（Python 环境与依赖），可能需要几分钟到十几分钟，取决于磁盘速度与杀毒软件。",
      starting: "正在启动本地服务…",
      waited: (seconds: number) => `正在启动本地服务…（已等待 ${seconds} 秒）`,
      hint: "启动期间可以最小化窗口，首次准备环境不会中断。",
      checkingTitle: "正在检查关键组件",
      checkingSub: "全部通过后即可进入模型配置。",
      readyTitle: "环境已就绪",
      readySub: "关键组件检查通过，继续配置模型即可开始使用。",
      failedTitle: "环境准备遇到问题",
      failedSub: "可以查看日志后重试；杀毒软件可能拦截了环境准备。",
      timeoutTitle: "部分组件未就绪",
      timeoutSub: "执行引擎首次准备可能较慢；可等待后重新检查。",
      fallbackError: "未知原因。可查看日志后重试；杀毒软件可能拦截了环境准备。",
      /* [U5c] The Seatbelt keys of this block (items.seatbelt,
         seatbeltFailedTitle/RetryHint/NotApplicable/OptInTitle) are retired
         with the wizard's Seatbelt row and banner: sandbox health lives in
         设置 › 连接 › 沙箱网络's status row alone (owner decision 2026-11-23). */
      items: {
        api: "本地 API 服务",
        runner: "执行引擎（Python 运行环境）",
        model: "默认任务模型（可选，可稍后在设置中配置）",
      },
      notChecked: "未检查",
      runnerNeedsToken: "未检查（需要令牌）",
      retry: "重新检查",
      retryBoot: "重试",
      logs: "打开日志文件夹",
      next: "下一步：配置模型",
    },
    back: "返回上一步",
    optional: "可选",
    provider: {
      baseUrl: "基础URL",
      apiKey: "API key",
      apiKeyPlaceholder: "请输入 API key",
      reveal: "显示",
      conceal: "隐藏",
      model: "模型名称",
      modelPlaceholder: "例如 deepseek-chat",
      fetch: "刷新列表",
      fetching: "正在刷新…",
      /** What the refresh button does, and that the field is also free text. */
      fetchHint: "从服务商读取可用模型；也可以直接填写模型名。",
      /** The name of the combobox's caret, for a screen reader. */
      choose: "选择模型",
      noMatch: (query: string) => `没有匹配「${query}」的模型，可直接输入该名称。`,
      empty: "这个服务商没有返回任何模型，请确认基础 URL 与密钥。",
      preset: "服务商类型",
      tokenOptional: "本地服务，可不填",
    },
    custom: {
      option: "自定义（手填地址）",
      name: "自定义网关",
      protocol: "接口协议",
      protocols: {
        "anthropic-messages": "Anthropic Messages",
        "openai-chat-completions": "OpenAI Chat Completions",
        "openai-responses": "OpenAI Responses",
      } as Record<string, string>,
    },
    testAndContinue: "测试并继续",
    retest: "重新测试",
    finish: "开始使用",
    testing: "正在测试…",
    testOk: (latency: number) => `✓ 基础检查通过（${latency} ms）`,
    // 通过仅证明服务商应答了一次最小请求——不代表完整会话执行路径、思考或工具调用可用（issue #824）。
    basicCheckNotice: "仅基础检查：不验证完整会话执行路径、思考或工具调用。",
    missingKey: "请先填写 API key。",
    missingModel: "请先选择或填写模型名。",
    /** Fallbacks for a connectivity failure whose message came back empty. */
    testCategories: {
      authorization: "密钥被拒绝，请确认这串 Key 与所选服务商匹配。",
      invalid_response: "地址有响应，但返回内容不是模型接口的格式，多半是基础 URL 选错了。",
      missing_token: "这个服务商需要 API key。",
      network: "连不上这个地址，请检查网络或自定义地址是否可达。",
      not_found: "接口返回 404，请检查基础 URL 是否少了或多了路径段。",
      ok: "连接成功。",
      provider_error: "服务商返回了错误，请稍后重试。",
      rate_limited: "被限流了，密钥本身可用。",
      timeout: "连接超时。",
    } as Record<string, string>,
    saveFailed: (message: string) => `保存失败：${message}`,
  },

  settings: {
    close: "关闭设置",
    /** 设置 › 通用: preferences that belong to this browser rather than to the
     *  service. */
    general: {
      language: {
        heading: "语言",
        field: "界面语言",
        english: "English",
        chinese: "简体中文",
      },
      /** The row that plays the first-run guide again. It is here rather than
       *  behind a help menu because 设置 › 通用 is where a user looks when the
       *  interface is the problem. */
      guide: {
        heading: "新手引导",
        field: "界面导览",
        action: "重新查看",
      },
    },
    loading: "正在读取…",
    retry: "重试",
    edit: "编辑",
    /** The pair above 技能 / MCP 服务器 / 专家's lists, which writes every row
     *  of the list at once. */
    enableAll: "一键启用",
    disableAll: "一键关闭",
    saveFailed: "保存失败，请重试。",
    cancel: "取消",
    model: {
      add: "添加模型",
      addHint: "选择服务商，填入地址与密钥，再从服务商返回的列表中选择模型。",
      save: "保存",
      default: "主模型",
      empty: "还没有配置模型。没有模型就无法发送消息。",
      setDefault: "设为主模型",
      defaultFailed: "没能把这个模型设为默认，请重试。",
      test: "测试连接",
      testFailed: (message: string) => `✕ ${message}`,
      testOk: (latency: number) => `✓ 基础检查通过（${latency} ms）`,
      testOkNotice: "仅基础检查：不验证完整会话执行路径、思考或工具调用。",
      /** Shown on the credits model while no account is signed in. */
      requiresSignIn: "登录后可用",
      delete: "删除",
      deleteConfirm: (name: string) => `删除模型「${name}」？`,
      deleteBody: "删除后，明确指定此模型的会话需要重新选择模型。历史运行记录保留。",
      replacement: "新主模型",
      leaveUnset: "暂不设置",
      deleteFailed: "没能删除这个模型，请重试。",
      expand: "展开模型设置",
      name: "模型名称",
      nameHint: "显示在模型列表和会话的模型菜单里。",
      nameRequired: "名称不能为空。",
      nameFailed: "没能保存模型名称，请重试。",
      cancel: "取消",
      pickHint: "从服务商返回的模型里选择，选中即保存。已经被其他条目用掉的模型不能重复选择。",
      switchFailed: "没能切换模型，请重试。",
      addedOption: "已添加",
      providerRefresh: "刷新列表",
      providerRefreshHint: "重新向服务商读取模型列表，不使用缓存。",
      refreshing: "读取中…",
      saving: "正在保存…",
      providerSource: "服务商返回",
    },
    skills: {
      detail: "详情",
      empty: "没有读到技能。",
      search: "搜索技能",
      searchPlaceholder: "搜索技能…",
      /** The × inside the search field that puts the whole list back. */
      clearSearch: "清空搜索",
      noMatches: "没有匹配的技能。",

      heading: "技能",
      jiuwenSwarmOnly: "当前执行器不是 JiuwenSwarm，技能开关不可用。",
      noProject: "还没有可用的项目，无法读取技能选择。",
      off: "已停用",
      on: "已启用",
      toggle: (name: string) => `启用或停用「${name}」`,
      installedCount: (count: number) => `已安装 ${count}`,
      /** The three tabs above the list. The count is part of the label, as in
       *  the handoff: every row the tab holds, not only those matching the
       *  current search. */
      tabs: {
        label: "技能分类",
        all: (count: number) => `全部技能（${count}）`,
        mine: (count: number) => `我的技能（${count}）`,
        official: (count: number) => `官方技能（${count}）`,
        basic: "基本信息",
        files: "技能详情",
      },
      /** The way out of a package's own page. */
      back: "返回",
      /** 技能详情: the package's files on the left, one of them open on the right. */
      fileTree: {
        list: "文件列表",
        reading: "正在读取文件…",
        copy: "复制",
        download: "下载",
        copied: "已复制",
      },
      /** The tag on a card: a package that ships with the app, or one the user
       *  brought in. */
      cardTag: {
        builtIn: "内置",
        external: "外部",
      },
      /** A category the user opened that holds no rows at all. */
      emptyScope: "这个分类下还没有技能。",
      /** The list's own subtitle. The directory's entry keeps the shorter line
       *  it uses as a tooltip; this page says what the page itself does. */
      listDescription: "管理并安装智能体可用的技能",
      /** The native save dialog a Skill export opens. */
      exportDialog: {
        title: "导出技能",
        filterName: "技能包",
        buttonLabel: "保存",
      },
      /** The one press that adds a Skill, and the three ways to do it. The
       *  hint is the second line of each entry: the three labels are short
       *  enough to look alike, and what differs is where the package comes
       *  from. */
      addMenu: {
        label: "添加技能",
        scratch: "从零开始写",
        upload: "上传技能",
        git: "从 GitHub 导入",
      },
      backToList: "返回技能列表",
      createView: {
        title: "从零开始写",
        description: "名称会作为技能 ID。创建后可以在列表里继续编辑。",
      },
      create: "创建",
      name: "名称",
      namePlaceholder: "例如：literature-review",
      nameHint: "只能使用小写字母、数字和连字符，创建后作为技能 ID。",
      nameInvalid: "名称只能包含小写字母、数字和单个连字符。",
      description: "描述",
      descriptionPlaceholder: "说明这个技能做什么、什么时候使用。",
      instructions: "指令",
      instructionsPlaceholder: "写明步骤、判断标准和输出格式。会作为 SKILL.md 正文。",
      license: "许可证",
      licensePlaceholder: "可选，例如 MIT",
      version: "版本",
      versionPlaceholder: "可选，例如 1.0.0",
      compatibility: "兼容性",
      compatibilityPlaceholder: "可选，例如：需要 Python 3.11 与网络访问",
      /** A skill that declared no version is still described by the revision it
       *  is installed at; the word carries it, so the card does not print the
       *  server's `revision:1` after a `v`. */
      revision: (revision: number) => `第 ${revision} 版`,
      source: {
        builtIn: "SD 内置",
        jiuwenBuiltIn: "JiuwenSwarm 内置",
        jiuwenLocal: "JiuwenSwarm 安装",
        managed: "自建",
      },
      instructionsLoading: "正在读取指令…",
      /** 技能 › one package: the instructions' section heading. */
      detailView: {
        files: "文件",
      },
      /** The chevron on a managed Skill's row. */
      rowMenu: {
        actions: (name: string) => `「${name}」的操作`,
        export: "导出",
        edit: "编辑",
        delete: "删除",
        exported: (name: string) => `已导出「${name}」。`,
        exportUnsupported: "后端没有找到这个技能包。请确认后端是最新构建并包含技能导出接口，然后重试。",
        exportFailed: "没能导出这个技能。",
        deleteTitle: (name: string) => `删除「${name}」`,
        deleteBody: (name: string) =>
          `「${name}」会从这台机器上移除，包含它的文件和版本记录。此操作无法撤销。`,
        deleteBlocked: (name: string, count: number) =>
          `「${name}」仍被 ${count} 个项目或会话选中。先在这些地方取消选择，再删除它。`,
        deleted: (name: string) => `已删除「${name}」。`,
        deleteFailed: "删除失败。",
      },
      uploadView: {
        title: "上传技能",
        description: "把本机的 SKILL.md 或技能包添加到 ScienceDiscovery。",
        dropTitle: "拖到这里，或点击选择文件",
        dropHint:
          "支持单个 SKILL.md，以及包含 SKILL.md 的 .zip / .skill 技能包；ZIP 里的脚本和参考资料会一起导入。",
        reading: "读取中…",
        remove: "移除",
        fileSize: (kilobytes: number) => `${kilobytes} KB`,
        writeInstead: "改为从零开始写",
      },
      importAction: "导入",
      /** The close control every 技能 dialog carries. */
      closeDialog: "关闭",
      /** 技能 › 上传技能, as the handoff's dialog. */
      uploadDialog: {
        hint: "文件夹或 .zip 需要包含 SKILL.md，单个 .md 文件需要有 YAML 格式的名称和描述；一个压缩包只能装一个技能包，整个仓库请用「从 GitHub 导入」。",
        chooseFile: "选择文件",
        dropTitle: "选择Skill.md文件",
        dropHint: "点击或拖动压缩包或文件到此处",
        reselect: "重新选择",
        cancel: "取消",
        confirm: "确定",
        /** 上传被服务端拒绝时，按拒绝的事实写出的句子。 */
        refusals: {
          entries: (actual: number, cap: number) => `压缩包里有 ${actual} 个条目，上限是 ${cap} 个。`,
          files: (actual: number, cap: number) => `技能包里有 ${actual} 个文件，上限是 ${cap} 个。`,
          archiveBytes: (actual: string, cap: string) => `压缩包大小是 ${actual}，超过了 ${cap} 的上限。`,
          extractedBytes: (actual: string, cap: string) => `解压后的内容有 ${actual}，超过了 ${cap} 的上限。`,
          fileBytes: (path: string, cap: string) => `「${path}」超过了单个文件 ${cap} 的上限。`,
          missingRoot: "压缩包的根目录里没有 SKILL.md。",
          severalRoots: "压缩包的顶层不是单个技能包目录。",
          outsideRoot: "压缩包里有技能包根目录之外的文件。",
          onePackage: "一个压缩包只能导入一个技能包。如果这是装着多个技能的仓库，请改用「从 GitHub 导入」，先选择要导入的技能。",
        },
      },
      /** 技能 › 从 GitHub 导入, as the handoff's dialog. */
      gitDialog: {
        subtitle: "从公开的 Github 仓库中导入",
        advanced: "高级选项",
        progress: (done: number, total: number) => `正在导入(${done}/${total})`,
        importing: "导入中",
        invalidUrl: "URL格式不正确，请重新输入",
      },
      importBusy: "正在导入…",
      backgroundImportDone: (count: number) => `已导入 ${count} 个技能。`,
      backgroundImportPartial: (imported: number, failed: number) => `已导入 ${imported} 个，${failed} 个失败。`,
      backgroundImportEnableFailed: (imported: number, failed: number) =>
        `已导入 ${imported} 个技能，但 ${failed} 个未能启用。`,
      backgroundImportFailed: "后台导入失败。",
      backgroundImportFailures: (names: string, count: number) =>
        count > 3 ? `失败：${names} 等 ${count} 个` : `失败：${names}`,
      importFailed: "导入失败。",
      importSucceeded: (name: string) => `已导入「${name}」。`,
      /** The 技能 page's own notices (design 1-4). */
      toastUploadDone: (name: string) => `「${name}」上传成功！`,
      toastUploadNotEnabled: (name: string) => `「${name}」已导入，但未能启用。`,
      toastGitDone: "GitHub 技能导入成功！",
      toastGitFailed: "GitHub 技能导入失败",
      toastProgress: (done: number, total: number) => `正在导入(${done}/${total})`,
      toastRetry: "点击重试",
      toastClose: "关闭提示",
      git: {
        title: "从 GitHub 导入",
        description: "先检查仓库里有哪些技能包，再选择要导入的条目；导入会固定在你看到的那次提交上。",
        url: "仓库地址",
        urlPlaceholder: "https://github.com/org/repo.git",
        ref: "Ref",
        refPlaceholder: "可选，例如 main",
        subdirectory: "子目录",
        subdirectoryPlaceholder: "可选，例如 skills/my-skill",
        inspect: "检查",
        inspecting: "正在检查…",
        inspectHint: "正在克隆仓库并读取所有 SKILL.md；通常只需几秒，网络较慢时会更久。",
        cancelInspect: "取消",
        inspectNetwork: "无法连接 GitHub。请检查网络、代理或 VPN 后重试。",
        inspectTimeout: "连接 GitHub 超时。请检查网络、代理或 VPN 后重试。",
        checkoutFailed: "拉取仓库失败。请检查仓库地址、网络与代理设置后重试。",
        inspectFailed: "无法检查这个仓库。",
        commit: (commit: string) => `commit ${commit.slice(0, 12)}`,
        new: "新技能",
        update: "可更新",
        unchanged: "无变化",
        invalid: "不可用",
        selectHint: "勾选要导入的技能包。无变化和不可用的条目不能导入。",
        found: (count: number) => `找到 ${count} 个技能包`,
        selectAll: "全选",
        importSelected: (count: number) => `导入选中的 ${count} 项`,
        /** 一次检查只返回一页；仓库里还有更多时，这个按钮接着读下一页，
         *  已经读到的条目和勾选都保留。 */
        loadMore: "加载更多",
        loadingMore: "正在加载…",
        loaded: (loaded: number, total: number) => `已加载 ${loaded} / 共 ${total} 个`,
        empty: "这个仓库里没有找到技能包。",
      },
      editor: {
        edit: "编辑",
        title: (name: string) => `编辑 ${name}`,
        hint: "修改字段与文件；保存后对新的会话生效。",
        files: "文件",
        save: "保存",
        saving: "正在保存…",
        saved: "已保存。",
        loadFailed: "没有读到这个技能。",
        binary: "这个文件不是 UTF-8 文本，无法在这里编辑。",
        readOnly: "内置技能只读。",
        conflict: "编辑期间技能已被修改。请重新打开后再试。",
        name: "名称",
        description: "描述",
        descriptionHint: "智能体依据这句话判断何时使用该技能——写具体些。",
        instructions: "指令",
        license: "许可证",
        compatibility: "兼容性",
        cancel: "取消",
        content: "内容",
        contentHint: "技能被调用时展示给智能体的 Markdown。",
        write: "撰写",
        upload: "上传",
        uploadTitle: "上传 SKILL.md 或文本文件",
        uploadHint: "其内容会填入编辑器；切回「撰写」即可调整。",
        contentReadFailed: "没有读入这个文件。",
        pasteHint: "粘贴完整的 SKILL.md——如果开头有 --- 元数据块，上面的字段会自动填充。",
        advanced: "高级设置",
        references: "参考文件",
        referencesHint: "技能在运行时读取的辅助文件（脚本、模板、数据）。",
        referencesUsage: (count: number, total: number, size: string, limit: string) =>
          `参考文件: ${count} / ${total}；包大小: ${size} / ${limit}`,
        referencesDrop: "拖入参考文件，或点击浏览",
        referencesDropHint: (directory: string) => `保存在技能的 ${directory} 下。`,
        referencesEditHint: "点击下面的文件，在行内展开编辑。",
        editResource: (path: string) => `编辑 ${path}`,
        referenceDirectory: "目标目录",
        referenceDirectoryPlaceholder: "例如 references、assets 或 scripts",
        referenceDirectoryHint: "新文件保存到这个子目录；留空表示技能根目录。",
        referenceDirectoryInvalid: "目录不能为空段、不能包含 . 或 ..。",
        editingResource: (path: string) => `正在编辑参考文件：${path}`,
        saveFile: "保存文件",
        closeReferenceEditor: "关闭参考文件编辑器",
        /** 2-3: the file editor. */
        exit: "退出编辑",
        unsaved: "未保存",
        unsavedTitle: "尚未保存更改",
        unsavedBody: "当前内容尚未保存，返回后所做的更改将会丢失。确定要离开吗？",
        deleteTitle: "确认删除？",
        deleteBody: "删除后将无法恢复，确定要删除此内容吗？",
        newFolder: "新建文件夹",
        newFile: "新建文件",
        newFileIn: (path: string) => `在「${path}」下新建文件`,
        uploadFile: "上传",
        filePathPlaceholder: "文件名或路径，例如 references/new.md",
        folderPathPlaceholder: "文件夹名，例如 references",
        invalidPath: "名称不能为空、不能以 / 开头，也不能包含 . 或 ..。",
        editPath: (path: string) => `编辑 ${path}`,
        rename: "编辑名称",
        deleteAction: "删除",
        deletePath: (path: string) => `删除 ${path}`,
        saveFailed: "保存失败。",
        uploadNotText: (name: string) => `「${name}」不是文本文件，无法作为技能文件上传。`,
        referenceEditingHint: "修改后点「保存文件」。",
        referenceNotText: (name: string) => `「${name}」不是 UTF-8 文本，不能作为参考文件导入。`,
        addReferenceFailed: "没有读入这个参考文件。",
      },
    },
    network: {
      heading: "网络",
      sandbox: {
        heading: "沙箱网络",
        mode: "沙箱网络模式",
        modeNone: "无网络",
        modeAllowlist: "域名白名单",
        modeOpen: "开放网络",
        modeOpenWarning: "开放网络意味着沙箱里的任何代码都能访问任意地址，只保留私网过滤。确定要这样吗？",
        saved: "沙箱网络已保存",
        /** The allowlist editor. The accepted format is shown by the
         *  placeholder rather than explained in a sentence. */
        domains: "允许的域名",
        domainsPlaceholder: "example.org\n*.example.org:443",
        emptyDomains: "至少填写一个允许的域名。",
        saveDomains: "保存",
        scope: "只作用于 run_shell 与沙箱内的代码。",
        /** [mac-direct] 安装级 opt-in。开启后本地代码执行不再经过沙箱：
         *  影响范围是整个本地执行栈——Agent 的临时 Shell/Python 与程序
         *  演进的候选程序都以你本人的文件、网络与环境权限运行；持久
         *  Shell 会话与持久内核仅在沙箱可用时提供，无沙箱时不可用；
         *  程序演进每次运行前仍会单独确认。仅 macOS 壳层显示。
         *  文案红线：如实描述完整影响范围，不得缩窄为「仅候选程序」
         *  （评审 2026-11-23 要求）。
         *  [hint-split] 呈现分层（2026-11-24 用户实测反馈）：hint 只留
         *  一句主旨，完整影响范围移入 hintDetails；内容逐条保留，红线
         *  不变——测试断言改为 hint + hintDetails 合并文本。
         *  [F29] 重启条款留在主旨 hint，不进 details：拨动开关没有即时
         *  反馈（状态行在下次 spawn 前一直报 spawn 时的模式），条款是
         *  唯一能解释拨动后窗口期的文字——在唯一要紧的时刻必须常显。 */
        directExecution: {
          heading: "沙箱",
          field: "无沙箱运行本地代码",
          hint: "开启后，本地代码执行不经过沙箱。重启应用后生效。",
          hintDetails: [
            "代码以你本人的文件、网络与环境权限运行（含 Agent 的临时 Shell/Python 与程序演进的候选程序）",
            "持久 Shell 会话与持久内核需要沙箱，届时不可用",
            "R 语言执行需要沙箱，开启后不可用（直跑通道仅支持 Python）",
            "程序演进每次运行前仍会单独确认",
            ],
          showDetails: "了解完整影响",
          hideDetails: "收起",
        },
        /** [U5c] 设置 › 连接 › 沙箱网络 的沙箱状态行——沙箱健康信息的唯一展示处
         *  （owner 2026-11-23：初始化不拦截不提示，沙箱监测只在设置）。
         *  [F16] 行的状态由开关与探测共同推导：开关 OFF 时 ok/failed 如实
         *  描述探测与会话模式；开关 ON 时一律 optedOut——会话实际是无沙箱
         *  直跑，行必须如实说，回退方式是关闭开关重启（不是"恢复沙箱后
         *  重启"）。[F14] not-applicable/unknown 两态已删：IPC 层把非
         *  darwin 探测结果归一为 null，行不渲染。failCause 按 detail.
         *  failCode 本地化成因。 */
        status: {
          field: "沙箱状态",
          ok: "✓ macOS 沙箱（Seatbelt）运行中，本地代码执行经过沙箱",
          /** [F26] The adopted-stack window: this session attached to an
           *  already-running backend, so the mode the ok/optedOut sentences
           *  would assert is an inference from this shell's inputs, not the
           *  survivor's env — the row says so instead of guessing.
           *  [F26-followup] No restart advice: quitting stops only a stack
           *  this shell spawned, so a restart usually re-adopts the same
           *  surviving stack. The honest way to verify is to stop that
           *  backend and let the app spawn its own. */
          attached: "本次会话连接了一个已在运行的后端栈，其沙箱模式未经本会话验证（无法从外部确认）。如需确认运行模式，请先停止该后端进程（在启动它的终端中中断，或在“活动监视器”中结束），再由应用自行启动栈。",
          /** [F16] The honest row: when the switch is ON, the session runs
           *  direct no matter what the probe said — the row must say so. The
           *  way back is the switch, not "restore and restart". */
          optedOut: "本地代码当前不经沙箱直接运行（你已开启下方开关）。关闭开关并重启应用，即可回到沙箱模式。",
          /** [F22] The mid-session toggle-off window: the stack still runs
           *  direct but the switch is already OFF — tell the user the restart
           *  is what applies their change, not "turn off the switch" (which
           *  they just did). [F24] No probe clause here: this sentence only
           *  renders when the probe verdict is not "failed" (the failed
           *  branch wins the row), so a probe cause can never reach it. */
          optedOutSwitchOff: "本地代码当前不经沙箱直接运行（本次会话启动时无沙箱开关为开启状态）。重启应用后，即可回到沙箱模式。",
          /** The probe failed this session — the cause follows from the
           *  structured detail (failCause sentence), the raw reason rides the
           *  dot's tooltip with the diagnostics. R execution needs a sandbox
           *  and is refused in this session too (F17). */
          failed: "沙箱不可用：本次会话以无沙箱模式运行本地代码，R 语言执行与持久 Shell 会话/持久内核不可用（详见下方开关说明）；程序演进每次运行前仍会单独确认。",
          /** Composed from detail.failCode — zh sentences for the three
           *  structured causes (spawn-error / signal / exit-code). */
          failCause: {
            "spawn-error": "原因：找不到 sandbox-exec 命令。",
            signal: "原因：探测进程被信号终止，无法确认 Seatbelt 可用。",
            "exit-code": "原因：在 MDM 受控或嵌套虚拟化环境中 Seatbelt 可能被禁用。",
            },
        },
      },
    },
    runtime: {
      heading: "远程",
      allowlist: {
        empty: "还没有可用的远端机器。先在上面登记一台，等它连上。",
        heading: "允许的机器",
      },
      runner: {
        add: "新增远端 Runner",
        alias: "SSH 别名或 IP/主机名",
        aliasPlaceholder: "例如：gpu-01 或 10.0.0.9",
        cancel: "取消",
        connect: "连接",
        connecting: "正在连接…",
        connectLog: {
          empty: "这次连接还没有输出。",
          heading: "连接过程",
          live: "进行中",
        },
        cpuCores: (count: number) => `${count} 核`,
        credentials: {
          cancel: "取消",
          forget: "忘记已存的密码、私钥和口令",
          heading: "登录凭据",
          keyKeep: "留空则沿用已存的私钥",
          note: "凭据只写不读：存进去之后接口不会再返回它们，这里留空就是沿用已存的那一份。",
          passphraseKeep: "留空则沿用已存的口令",
          passphrasePlaceholder: "私钥没有口令就留空",
          secretKeep: "留空则沿用已存的密码",
          save: "保存并测试",
        },
        delete: "删除",
        deleteBody: "删除后这台机器上已连上的 Runner 会断开，它也从本项目的允许列表里消失。已经跑完的结果不受影响。",
        deleteConfirm: (name: string) => `删除机器「${name}」？`,
        destinationUnknown: "地址未知",
        disconnect: "断开",
        empty: "没有已登记的 Runner。",
        endpoint: "地址",
        endpointPlaceholder: "10.0.0.9:4311",
        keyFile: "私钥文件",
        keyPair: {
          copied: "已复制",
          copy: "复制公钥",
          generate: "生成密钥对",
          note: "私钥留在服务的数据目录里，不经过浏览器。把这行公钥装进机器的 ~/.ssh/authorized_keys，再测一次连接。",
          title: "公钥",
        },
        keyPlaceholder: "这个服务能读到的路径，例如 ~/.ssh/id_ed25519",
        keyStored: "已存私钥",
        /** The readings a connected Runner reports about its own machine. */
        resources: {
          aria: "Runner 资源",
          cores: "CPU 核数",
          diskUnknown: "工作区磁盘：未知 · 连接 Runner 后进行测量",
          diskUsed: "磁盘已用",
          gpu: (gpu: string) => `GPU：${gpu}`,
          hours: "小时",
          load1m: "负载 · 1 分钟",
          lowDisk: (available: string, required: string) =>
            `工作区磁盘空间不足：仅剩 ${available}，Runner 必备组件加两个基础 conda 环境预估需要约 ${required}。环境安装和文件写入可能失败。`,
          memoryUsed: "内存已用",
          meterUnknown: (label: string) => `${label}：未知`,
          noMetrics: "工作区磁盘：指标暂不可用",
          updated: "更新于",
          uptime: "主机运行时长",
        },
        /** The Ascend cards a Runner may hand to a sandbox, and which of them
         *  the operator picked. */
        npu: {
          aiCore: (percent: number) => `AI Core ${percent}%`,
          aiCoreLabel: "AI Core 占用率",
          card: (chip: string, index: number) => `NPU ${index} · ${chip}`,
          cardChip: (card: number, die: number, chip: string, index: number) =>
            `NPU ${card} · die ${die} · ${chip}（设备 ${index}）`,
          count: (total: number, usable: number) => `本机 ${total} 张 · 沙箱内可用 ${usable} 张`,
          discard: "放弃修改",
          memoryCaption: "显存",
          memoryLabel: "显存用量",
          none: "本机未报告任何昇腾卡。",
          noneUsable: "本机当前没有任何一张卡能在沙箱中打开，因此无法勾选。",
          power: (watts: number) => `${watts} W`,
          powerLabel: "功率",
          renumbered: "勾选的卡在沙箱内从 0 开始重新编号，代码可以直接使用 device 0。",
          save: "保存勾选",
          saving: "保存中…",
          temperature: (celsius: number) => `${celsius} °C`,
          temperatureLabel: "温度",
          title: "NPU 卡",
          unusable: "这张卡无法在沙箱中打开。",
          unusableSelected: "使用它的执行会一直失败，直到它被释放；取消勾选即可不带这张卡运行。",
          unsaved: "有未保存的勾选",
        },
        kind: {
          direct: "自部署",
          local: "本地",
          ssh: "SSH",
        },
        kindLabel: "接入方式",
        local: "本地",
        localHelp: "本机执行，不需要登记。",
        machineDetails: "机器详情",
        noDetail: "这个 Runner 还没有回报过状态。",
        passphrase: "私钥口令",
        secret: "登录密码",
        secretStored: "已存密码",
        port: "SSH 端口",
        portLabel: "端口",
        portPlaceholder: "留空用 22",
        reachability: {
          checking: "正在探活",
          checkingHelp: "正在问这台机器是否在线。",
          offline: "机器离线",
          offlineHelp: "Runner 没连上，机器本身也没有应答。",
          online: "机器在线",
          onlineHelp: "Runner 还没接上，但机器本身有应答。",
          unknown: "机器状态未知",
          unknownHelp: "这台机器没有存下的凭据，问不到它是否在线。",
        } as Record<string, string>,
        register: "登记并测试",
        registerDirect: "登记并连接",
        /** Prefilling the form from an existing `ssh_config` entry — a
         *  convenience, since the product speaks SSH itself afterwards. */
        sshConfig: {
          import: "从 ssh_config 导入",
          importFailed: (alias: string) => `无法从 ssh_config 导入 ${alias}`,
          listFailed: "无法读取 ssh_config",
          loading: "正在读取 ssh_config…",
          none: "这份 ssh_config 里没有可导入的 Host 条目。",
          note: (alias: string, target: string, keyNote: string) =>
            `已从 ssh_config 导入 ${alias}${target}${keyNote} — 所有字段仍可编辑。`,
          noteKeyUnreadable: " — 此安装环境无法读取该私钥文件，请选择其他密钥文件或生成新密钥",
          noteTarget: (host: string) => `（连接到 ${host}）`,
          portPrefix: (port: number) => `端口 ${port}`,
        },
        /** Browsing for a key file. What is browsed is the API's own machine:
         *  a private key has to be readable where the product runs. */
        keyBrowser: {
          aria: "应用所在机器上的文件",
          browse: "浏览",
          browseFailed: "无法浏览应用所在机器",
          cancelSelection: "取消选择",
          empty: "该目录下没有文件。",
          folder: "文件夹",
          go: "前往",
          help: "这些文件属于运行 ScienceDiscovery 的机器，既不是本浏览器，也不是远端 SSH 目标机。只会填入所选路径，不会显示文件内容。",
          home: "主目录",
          loading: "正在加载文件…",
          nextPage: "下一页",
          pathLabel: "目录或文件路径",
          previousPage: "上一页",
          selectFile: "选择文件",
          title: "在应用所在机器上选择密钥",
          unavailable: "不可用",
          up: "上一级",
        },
        runnerCommand: "Runner 可执行文件",
        state: {
          connectFailed: "连接失败",
          connecting: "连接中",
          disconnected: "未连接",
          error: "异常",
          ready: "就绪",
          starting: "启动中",
          stopped: "已停止",
          unknown: "未知",
        } as Record<string, string>,
        token: "访问令牌",
        tokenPlaceholder: "远端 runner 的 SCIENCE_AGENT_RUNNER_TOKEN",
        trust: {
          cancel: "取消",
          changed: (target: string) => `${target} 的主机密钥和上次不一样了。`,
          changedBody: "要么这台机器换了密钥，要么中间有人在替它应答。核对过新指纹确实来自这台机器再继续。",
          confirm: "信任并继续",
          unknown: (target: string) => `还不认识 ${target} 的主机密钥。`,
          unknownBody: "这是第一次连这台机器。指纹和机器管理员给你的那份一致，才说明连的是它本身。",
        },
        untrusted: "主机密钥待确认",
        unusable: "当前不可用",
        username: "登录用户",
        usernamePlaceholder: "例如：researcher",
      },
    },

    /** 设置, the old front end's system-configuration modal: a grouped
     *  directory on the left and one pane at a time on the right. */
    system: {
      title: "设置",
      eyebrow: "设置",
      navLabel: "设置目录",
      save: "保存",
      saving: "保存中…",
      categories: {
        system: "系统",
        intelligence: "智能",
        connection: "连接",
        workspace: "工作区",
      },
      groups: {
        general: { label: "通用", description: "界面语言与这台设备上的偏好" },
        memory: { label: "科学记忆", description: "证据与产物的记忆服务" },
        models: { label: "模型", description: "模型档案与服务商凭据" },
        usage: { label: "模型用量", description: "当前服务记录的模型 Token 用量" },
        skills: { label: "技能", description: "创建、导入、编辑、启用或停用技能" },
        mcp: { label: "MCP 服务器", description: "管理内置与自定义 MCP 服务，选择会话默认使用的工具来源" },
        specialists: { label: "专家", description: "可复用的指令与工具组合" },
        "sandbox-network": { label: "沙箱网络", description: "run_shell 的网络访问" },
        remote: { label: "运行环境", description: "Runner 连接、资源、科学环境与全局软件包源" },
        quotas: { label: "运行配额", description: "并发、输出、工作区与上传上限" },
        web: { label: "联网搜索", description: "JiuwenSwarm 搜索服务与网页读取" },
        proxies: { label: "网络代理", description: "默认代理、服务器与模块策略" },
        timeouts: { label: "超时", description: "墙钟限制与不限模式" },
        "session-management": { label: "会话管理", description: "已归档的会话，可恢复或彻底删除" },
        "export-history": { label: "导出记录", description: "本机保存过的研究包" },
        "idea-tree": { label: "Idea Tree", description: "假设树的研究范围与阶段提示词" },
      },
      global: {
        modelHeading: "主模型",
        model: "默认模型",
        modelHint: "新会话在没有指定模型时使用它。",
        modelUnset: "未设置",
        approval: "默认批准方式",
        approvalHint: "新会话继承的权限模式。",
        connectorsHeading: "连接器",
        connectorsEmpty: "这台机器上还没有可用的连接器。",
      },
      mcp: {
        allMcp: "全部MCP",
        myMcp: "我的MCP",
        officialMcp: "官方MCP",
        searchMcp: "搜索MCP",
        enableAll: "一键启用",
        disableAll: "一键关闭",
        bulkHint: "批量操作仅影响当前显示的自定义服务；内置服务开关控制会话默认使用。",
        bulkFailed: (names: string) => `以下服务更新失败：${names}。可重试更新剩余服务。`,
        tryIt: "去试试",
        tryUnavailable: "未启用服务不支持；内置来源需处于可用状态。",
        noMatches: "没有匹配的 MCP 服务",
        manualEntry: "手动填写",
        importJsonEntry: "导入 JSON",
        jsonSource: "JSON 来源",
        importFillHint: "粘贴包含 mcpServers 的 JSON 或上传文件，检查并修改下方配置后，确认添加。",
        importEmptyHint: "粘贴或上传 JSON 后，配置会自动填入下方表单。",
        chooseConfiguration: "服务器配置",
        duplicateName: "服务器名称不能重复。",
        timeoutInvalid: "超时必须是 1 到 600 之间的整数。",
        commandRequired: "STDIO 需要填写命令。",
        urlInvalid: "请填写不含用户名、密码或片段的 HTTP(S) 地址。",
        confirmAdd: (count: number) => count > 1 ? `确认添加 ${count} 台服务器` : "确认添加",
        importFilled: (count: number) => `已填入 ${count} 份配置，请检查并修改后确认添加。`,
        importProgress: (added: number, total: number) => `已添加 ${added}/${total} 台，仅重试尚未添加的配置。`,
        addedCount: (count: number) => `已添加 ${count} 台 MCP 服务器`,
        savedCheckFailed: (reason: string) => `配置已保存。连接检查：${reason}`,
        importFieldInvalid: (name: string, field: string) => `「${name}」的 ${field} 无效，请修改 JSON 后重试。`,
        configured: "已配置的服务器",
        details: "服务器详情",
        custom: "外部",
        noDescription: "暂无描述",
        builtinReadOnly: "内置来源由应用管理，仅支持查看。",
        checkedAt: "最近检查时间",
        neverChecked: "暂无检查记录",
        checkHint: "连接状态为最近一次发现或测试的结果，并非持续心跳。服务启用与会话默认选用分别设置。",
        storedValue: "已安全保存",
        publisher: "发布者 / 版本",
        serviceEnabled: "已启用",
        selected: "已选用",
        notSelected: "未选用",
        authorized: "已授权",
        authorizing: "正在等待授权",
        deleted: "MCP 服务器已删除",
        retry: "重试",
        more: (name: string) => `${name}的更多操作`,
        openDetails: (name: string) => `查看${name}详情`,
        heading: "MCP 服务器",
        help: "“默认使用”选择继承全局设置的会话所用的来源；项目或会话的显式选择优先。专家可能补充其他来源，实际工具调用仍受服务就绪状态和权限限制。自定义服务器编辑表单中的“启用服务”单独控制连接。更改不会重新配置正在运行的任务。",
        builtin: "内置",
        useByDefault: "默认使用",
        enableService: "启用服务",
        selectAll: "全部选用",
        clearSelection: "取消全选",
        empty: "暂无可用的内置或自定义 MCP 来源。",
        editTitle: "编辑服务器",
        name: "名称",
        description: "说明",
        transport: "传输方式",
        command: "命令",
        args: "参数",
        argsHint: "每行一个参数。",
        cwd: "工作目录",
        url: "地址",
        timeout: "超时（秒）",
        optional: "可选",
        env: "环境变量",
        headers: "请求头",
        key: "键",
        value: "值",
        secretSaved: "已保存，留空沿用",
        addEntry: "新增一项",
        removeEntry: "删除这一项",
        secretKeyEmpty: "键不能为空。",
        secretKeyDuplicate: "键不能重复。",
        secretRenameRequired: "改名后需要重新填写对应的值。",
        authMode: "鉴权方式",
        authHeaders: "请求头",
        authOauth: "OAuth",
        clientId: "Client ID",
        clientSecret: "Client Secret",
        scope: "Scope",
        metadataUrl: "客户端元数据地址",
        callback: "回调地址",
        toolCount: (count: number) => `${count} 个工具`,
        statusReady: "已连接",
        statusError: "连接失败",
        statusDisabled: "已停用",
        statusUntested: "未测试",
        statusDegraded: "部分可用",
        statusMisconfigured: "配置有误",
        statusUnavailable: "不可用",
        test: "测试",
        testPassed: "连接测试成功",
        tested: (status: string) => `测试结果：${status}`,
        saved: "MCP 服务器已保存",
        deleteTitle: (name: string) => `删除服务器「${name}」？`,
        deleteBody: (name: string) => `删除「${name}」后依赖它的工具不再可用，已经跑完的结果不受影响。`,
        addServer: "新增 MCP 服务器",
        createTitle: "新增 MCP 服务器",
        importServers: "导入",
        importPaste: "粘贴 JSON",
        importFile: "上传 JSON 文件",
        importFileLoaded: (name: string) => `已读取文件：${name}`,
        importFileTooLarge: "JSON 文件不能超过 1.5 MB。",
        importFileReadFailed: "无法读取文件，请重新选择 JSON 文件。",
        importTooMany: "一次最多导入 50 台服务器。",
        importTitle: "导入 MCP 服务器",
        importHint: "粘贴包含 mcpServers 的 JSON 配置；逐台写入，并分别报告每台的结果。",
        importJson: "JSON",
        importPreview: "预览",
        importRun: "开始导入",
        importResults: "导入结果",
        importInvalidJson: "不是有效的 JSON。",
        importNoServers: "JSON 需要包含非空的 mcpServers 对象。",
        importBadEntry: (name: string) => `「${name}」不是一个服务器配置对象。`,
        importAdded: "已添加",
        importFailed: (reason: string) => `失败：${reason}`,
        tools: "工具",
        toolsNone: "没有返回任何工具。",
        testedResult: "测试结果",
        done: "完成",
        unauthorized: "未授权",
        authorizationExpired: "授权已过期",
        authorize: "授权",
        cancelAuthorization: "取消授权",
        clearAuthorization: "清除授权",
        nameRequired: "名称不能为空。",
        openAuthorization: "打开授权页面",
        actions: (name: string) => `${name}的操作`,
        importChoice: "导入 JSON",
      },
      web: {
        searchHeading: "搜索",
        free: "免费搜索引擎",
        freeHint: "不需要密钥，可作为兜底。",
        paid: "付费服务商",
        paidHint: "填了密钥并启用的服务商会优先使用。",
        deepseek: "DeepSeek 搜索",
        fetchHeading: "抓取与缓存",
        fetchProvider: "抓取服务商",
        searchCache: "搜索缓存（秒）",
        fetchCache: "抓取缓存（秒）",
        proxy: "代理策略",
        proxyHint: "Web 搜索与抓取使用的代理。",
        keysHeading: "服务商密钥",
        keysHint: "密钥只写不读：留空就是沿用已存的那一份。",
        keySet: "已设置",
        keyUnset: "未设置",
        keyPlaceholder: "粘贴新的 API Key",
      },
      memory: {
        heading: "记忆图谱",
        help: "科学记忆把研究报告引用的证据与产物保存成一张关系图，报告里的引用按钮就靠它展开。读写都经过本机的记忆服务。",
        enabled: "启用科学记忆",
        enabledHint: "关闭后不再写入或读取记忆，已有数据保留。",
      },
      ideaTree: {
        scopeHeading: "研究范围",
        template: "研究模板",
        templateHint: "决定假设与设计的提问方式。",
        templateGeneral: "通用科学假设",
        templateWater: "水处理材料",
        intensity: "探索强度",
        intensityHint: "越高越愿意展开更多方向，耗时与 token 也更多。",
        quick: "快速",
        standard: "标准",
        deep: "深入",
        direction: "评分方向",
        directionHint: "最大化表示分数越高越好；最小化反之。",
        maximize: "最大化",
        minimize: "最小化",
        maxDepth: "最大深度",
        maxDepthHint: "树的层数上限。",
        maxNodes: "最大节点数",
        maxNodesHint: "整棵树的节点上限。",
        tokens: "token 上限",
        tokensHint: "单次研究可用的总 token；留空表示不额外限制。",
        noCap: "不额外限制",
        promptsHeading: "阶段提示词覆盖",
        designPrompt: "设计阶段",
        aggregatorPrompt: "汇总阶段",
        propagatePrompt: "洞见传播",
        promptHint: "留空即使用模板自带的提示词。",
        promptPlaceholder: "留空使用模板默认",
        save: "保存",
        saving: "保存中…",
        saved: "已保存，对后续研究生效。",
        failed: "保存失败。",
        unavailable: "Idea Tree 服务尚未就绪：请先启动 Evolve 服务，再回到这里重试。",
      },
      specialists: {
        heading: "专家",
        add: "新增专家",
        help: "专家是可复用的指令与工具组合，任务可以指派给它们。",
        /** The line under the built-in Review Specialist. It says who uses it,
         *  which is the only thing there is to say about it: it cannot be
         *  turned off, so there is no state to describe. */
        reviewerUse: "由自动审阅使用",
        builtIn: "内置",
        enabled: "已启用",
        disabled: "已停用",
        editTitle: "编辑专家",
        name: "名称",
        namePlaceholder: "例如：RNA-seq 审查员",
        description: "描述",
        descriptionPlaceholder: "显示在列表中的简短描述",
        instructions: "指令",
        instructionsHint: "定义专家的角色与工作方式，工具和权限仍遵循平台规则。",
        instructionsPlaceholder: "例如：检查缺失值，并说明每项异常的判断依据。",
        runtime: "运行时",
        runtimeHint: "外部运行时使用对应的命令行智能体。",
        runtimeNative: "原生",
        model: "模型",
        modelHint: "留空则使用运行时默认模型。",
        connectors: "连接器",
        skills: "技能",
        none: "没有可选项。",
        capabilities: "能力",
        capabilitiesHint: "该专家可使用的技能和连接器。未在此处选择的项目，即使已全局启用，在其会话中也不可见、不可调用。",
        fullAccess: "完全访问",
        defaultTag: "默认",
        fullAccessHint: "使用主智能体的全部技能和连接器，包括以后新增的。无需逐项配置。",
        orSpecific: "或选择特定能力",
        addSkill: "添加技能",
        addConnector: "添加连接器",
        noSkills: "尚未添加技能。",
        unavailableSkill: (id: string) => `不可用技能：${id}`,
        unavailableSkillsHint: "部分已选技能已不在目录中。请显式移除这些条目后保存；不会自动扩大专家的能力范围。",
        noConnectors: "尚未添加连接器。",
        skillsNote: "技能列表初始为空，需要手动添加。未列在此处的技能对该专家不可见，对它们的技能调用会被拒绝。",
        connectorsNote: "连接器列表初始为空，需要手动添加。未列在此处的连接器对该专家不可见，对它们的调用会被拒绝。",
        pickerTitle: "添加技能和连接器",
        pickerEmptySkills: "没有可添加的技能。",
        pickerEmptyConnectors: "没有可添加的连接器。",
        remove: "移除",
        addSelected: "添加",
        deleteTitle: (name: string) => `删除专家「${name}」？`,
        deleteBody: (name: string) => `删除「${name}」后不能再把任务指派给它，已经跑完的结果不受影响。`,
      },
      proxies: {
        defaultHeading: "全局默认",
        default: "默认策略",
        defaultHint: "未单独设置代理的模块使用此策略。",
        serversHeading: "代理服务器",
        empty: "还没有登记代理服务器。",
        add: "新增代理",
        name: "名称",
        kind: "类型",
        kindCustom: "自定义 URL",
        kindEnvironment: "环境变量",
        kindSystem: "系统设置",
        url: "代理地址",
        urlHint: "例如 http://proxy.example.test:8080",
        urlStored: "已保存，留空不更改",
        noUrl: "没有地址",
        webHeading: "Web 策略",
        web: "Web 代理",
        webHint: "搜索与抓取使用的代理。",
        mcpHeading: "MCP 策略",
        mcpHint: "每个 MCP 服务器可以单独选择代理。",
        mcpEmpty: "还没有 MCP 服务器。",
        inherit: "继承全局默认",
        none: "不使用代理",
        environmentConfigured: "已配置",
        environmentUnconfigured: "未配置",
        environmentInvalid: "配置无效",
        environmentSource: (name: string) => `实际来源：${name}`,
        systemNote: "环境变量条目读取进程的 HTTP(S)、ALL_PROXY 与 NO_PROXY；系统条目解析桌面环境的代理设置。",
        deleteTitle: (name: string) => `删除代理「${name}」？`,
        deleteBody: (name: string) => `删除「${name}」后使用它的模块会退回全局默认，已经建立的连接不受影响。`,
      },
      usage: {
        range: "统计时间范围", today: "今日", week: "近 7 天", month: "近 30 天", all: "全部",
        refresh: "刷新", refreshing: "刷新中…", total: "总 Token", input: "输入 Token", output: "输出 Token",
        totalColumn: "总量", inputColumn: "输入", outputColumn: "输出", model: "模型", byModel: "按模型统计（Token）",
        unreported: "未上报", incomplete: "仅包含已上报用量，实际用量可能更高。",
        empty: "所选时间范围内暂无模型用量记录。", updated: "更新时间",
        skeleton: "正在读取模型用量…",
      },
      migrated: {
        common: {
          working: "处理中…",
          saved: "已保存",
          save: "保存",
          cancel: "取消",
          edit: "编辑",
          remove: "删除",
          refresh: "刷新",
          invalidNumber: "请输入有效的数值。",
          advanced: "高级设置",
        },
        environments: {
          heading: "科学环境",
          machinesHeading: "执行机器",
          connectionHeading: "连接与资源",
          overviewHint: "选择一台 Runner，管理它的连接、机器资源和科学环境。",
          back: "返回运行环境",
          skeleton: "正在读取运行环境…",
          runner: "执行机器",
          local: "内置 Runner",
          scope: "以下环境安装在这台机器上，供任务执行代码时使用。",
          localHint: "内置 Runner 位于后端服务所在机器。",
          unavailable: "请先在上方连接这台 Runner，再管理它的科学环境。",
          setup: "初始化状态",
          setupHint: "环境安装工具与基础环境是否准备就绪。",
          initialize: "初始化环境",
          retry: "重试初始化",
          states: {
            disabled: "不可用",
            failed: "初始化失败",
            installing: "正在初始化",
            "not-configured": "尚未初始化",
            ready: "就绪",
          },
          environmentStates: { ready: "就绪", updating: "正在更新", failed: "更新失败" },
          catalog: "环境列表",
          catalogHint: "基础环境只读；需要额外软件包时，可创建自建环境并安装。",
          empty: "这台机器上还没有可用环境。",
          base: "基础环境 · 只读",
          managed: "自建环境",
          create: "创建环境",
          creating: "创建中…",
          created: "已创建",
          name: "名称",
          language: "初始语言",
          packages: "要安装的软件包",
          packagesHint: "输入包名，可指定版本；多个包用空格、逗号或换行分隔。",
          installedPackages: "已安装软件包",
          installedPackagesHint: "当前环境修订记录的软件包，仅供查看。",
          manager: "包管理器",
          install: "安装",
          revision: "版本",
          noSnapshot: "暂无软件包快照。",
          sources: "全局安装源",
          sourcesHint: "所有 Runner 共用的软件包下载源，用于后续初始化和安装；已安装的软件包保持不变。",
          conda: "Conda 源",
          pip: "Pip 源",
          deleteTitle: "删除环境？",
          deleteBody: "将删除所选机器上的这个自建环境。",
          details: "环境详情",
        },
        web: {
          help: "配置 JiuwenSwarm 使用的搜索与网页读取服务。",
          unsupported: "当前后端不是 JiuwenSwarm，此页面暂不支持配置。",
          free: "免费搜索",
          freeHint: "无需密钥。保留至少一个引擎可在没有付费凭据时搜索。",
          paid: "付费搜索服务",
          paidHint: "配置密钥后加入 JiuwenSwarm 的付费搜索。实际使用顺序由后端决定，调用可能产生费用。",
          fetchHeading: "网页抓取",
          fetchProvider: "抓取来源",
          fetchDefault: "JiuwenSwarm 默认",
          fetchCost: "使用 DeepSeek 抓取会产生费用。",
          keyRequired: "使用 DeepSeek 前，请先在上方配置 API Key。",
          deepseekKeyHint: "保存后启用搜索，并与网页抓取共用密钥。留空沿用已有密钥。",
          searchInactive: "搜索未启用",
          reconfigureToEnable: "重新保存密钥可启用搜索。",
          deepseekRemoveBody: "移除后停用 DeepSeek 搜索，网页抓取恢复 JiuwenSwarm 默认方式。",
          key: "API Key",
          configure: "配置密钥",
          configured: "已配置",
          missing: "未配置",
          keyHint: "留空保留已有密钥；删除需要单独确认。",
          removeTitle: "移除密钥？",
          removeBody: "移除后，该服务将无法继续使用这份凭据。",
          saved: "设置已保存",
          activation: "保存会尝试同步 JiuwenSwarm；此处的保存状态不代表服务连通性或同步结果。",
        },
        proxy: {
          noProxy: "绕过代理",
          noProxyHint: "主机或域名用逗号分隔，如 localhost,.example.com；留空使用后端的 NO_PROXY。",
          scope: "代理配置在后端机器上生效。",
          swarmNote: "JiuwenSwarm 的搜索与网页读取使用独立的网络配置，不受此处设置影响。",
          test: "测试连接",
          testOk: "连接成功",
          testFailed: "连接失败",
          systemTest: "系统代理暂不支持连接测试。",
          deleteBody: "正在使用的代理无法删除，请先修改引用它的代理设置。",
          modules: "模块代理",
          mcp: "MCP 服务",
          web: "内置 Web 搜索与读取",
          diagnostics: "环境变量状态",
          nameRequired: "请输入代理名称。",
          urlRequired: "请输入完整的代理地址。",
        }
      },
      connection: {
        heading: "连接",
        help: "使用本地服务访问令牌连接这台机器上的 ScienceDiscovery。外部模型 API Key 请在「模型」中配置。",
        token: "本地服务访问令牌",
        hint: "令牌保存在这个浏览器中，不会写入服务配置。",
        storage: "更换令牌后，客户端会立刻用新令牌重新连接。",
        missing: "令牌不能为空。",
      },
      timeouts: {
        heading: "超时",
        help: "到达时限后这次操作会被取消。把某一项设为不限，它就不会超时。",
        gatewayIdle: "网关空闲超时",
        gatewayIdleHint: "连接一直没有新数据时等待的时间。",
        gatewayTurn: "单轮超时",
        gatewayTurnHint: "一轮对话允许的最长时间。两者都设置时，单轮时限不短于网关空闲时限；把其中一项设为不限则不受此限制。",
        kernelIdle: "内核空闲超时",
        kernelIdleHint: "持久内核闲置多久后回收。",
        permissionWait: "授权等待超时",
        permissionWaitHint: "等待用户批准的最长时间。",
        runnerExec: "执行超时",
        runnerExecHint: "沙箱里一次代码执行的最长时间。",
        seconds: "秒",
        unlimited: "不限",
        saved: "已保存",
        orderError: "单轮超时不能短于网关空闲超时。请调大单轮超时、调小网关空闲超时，或把其中一项设为不限。",
      },
      quotas: {
        heading: "配额",
        help: "容量设为不限可取消对应限制。输出上限控制截断，工作区和上传上限限制写入大小；并发设置用于后续运行。",
        subagents: "并行子智能体",
        subagentsHint: "一次运行中同时执行的子智能体数量上限（1–10）。",
        workspace: "工作区配额",
        workspaceHint: "单个会话工作区的总大小。",
        output: "输出保留上限",
        outputHint: "单次执行保留的 stdout 与 stderr 总量。",
        uploadFile: "单文件上传上限",
        uploadFileHint: "一次上传中每个文件的大小。",
        uploadRequest: "上传请求上限",
        uploadRequestHint: "一次上传请求的总体积。",
        gb: "GB",
      },
      runtime: {
        heading: "Runner",
        captured: "读取于",
        refresh: "刷新",
        runnerVersion: "Runner 版本",
        sessionsHeading: "运行中的会话",
        sessionsEmpty: "没有正在运行的会话。",
        executionsHeading: "执行",
        executionsEmpty: "没有正在执行的代码。",
        kernelsHeading: "持久内核",
        kernelsEmpty: "没有运行中的内核。",
        teardown: "结束内核",
      },
      runner: {
        heading: "Runner",
        local: "本地 Runner",
        localHelp: "本机执行，不需要登记。",
        remoteHelp: "这台机器上的连接状态、资源与允许列表。",
        add: "新增远端 Runner",
        addHelp: "登记一台远端机器，等它连上后就能在这里执行。",
        state: "状态",
        location: "位置",
        workspaceRoot: "工作目录",
        missing: "没有找到这个 Runner。",
        versionMismatch: (local?: string, remote?: string) =>
          `Runner 版本不一致：本地 ${local ?? "未知"}，远端 ${remote ?? "未知"}。`,
      },
    },
  },

  /** The full-width 产物 page reachable from the rail. */

  workspace: {
    newTab: "新标签页",
    artifacts: "产物",
    collapsible: "工作区",
    groups: {
      task: "任务",
      artifacts: "产物",
      files: "工作区",
    },
    /** The list shows every session's artifacts, so an empty list says the
     *  project has none rather than this session. */
    empty: "还没有产物。",
    filesEmpty: "工作区里还没有文件。",
    /** The document column before anything is opened. The lists beside it can
     *  be full, so this says what the screen is missing, not the session. */
    unopenedArtifacts: "还没有打开产物。",
    unopenedFiles: "还没有打开文件。",
    /** The note beside the heading of the open session's group. */
    currentSession: "当前会话",
    /** The heading of a group whose session the app has no title for. */
    untitledSession: "未命名会话",
    filesTitle: (count: number) => `工作区 · ${count} 个文件`,
    /** The count next to the 工作区 section header, which already says 工作区. */
    filesCount: (count: number) => `${count} 个文件`,
    sessionRoot: "本次会话",
    /** The tree's top row, which is the workspace itself, not a folder in it. */
    root: "工作区根目录",
    /** The age of a workspace file, as the tree states it. */
    justNow: "刚刚",
    minutesAgo: (minutes: number) => `${minutes} 分钟前`,
    hoursAgo: (hours: number) => `${hours} 小时前`,
    yesterday: "昨天",
    daysAgo: (days: number) => `${days}天前`,
    weeksAgo: (weeks: number) => `${weeks}周前`,
    open: "打开",
    unsupported: "这个类型暂时没有预览。",
    closeTab: "关闭页签",
    /** The draggable left edge of the panel. */
    resize: "调整面板宽度",
    /** The divider between the list and the document beside it. */
    resizeList: "调整列表宽度",
    /** The control that appears on an edge the divider closed. */
    expand: "展开",
    collapsePanel: "收起面板",
    /** The way out of a subagent's record or a tool's text, back to the
     *  panel's own groups. */
    backToGroups: "返回产物和文件",
    allArtifacts: "所有产物",
    download: "下载",
    /** The picker beside an open document that chooses which version of the
     *  artifact it shows. */
    version: "版本",
    searchArtifacts: "搜索产物",
    searchFiles: "搜索文件",
    /** A search that matched nothing, as opposed to a list that was empty. */
    searchEmpty: "没有匹配的内容。",
    /** The caption under a table that holds all of the document's rows. */
    tableRows: (count: number) => `共 ${count} 行`,
    /** The same caption when the panel holds only the head of a larger table. */
    tableRowsShown: (shown: number, total: number) => `显示前 ${shown} 行，共 ${total} 行`,
    /** A column whose first cell named nothing, named by where it sits. */
    tableColumn: (index: number) => `列 ${index}`,
    tableEmpty: "这个表格没有数据。",
    workbookUnreadable: "这个工作簿无法读取，请下载后查看。",
    worksheets: "工作表",
    imageAlt: (name: string) => `${name} 的预览`,
    imageActual: "按原始尺寸显示",
    imageFit: "适应面板宽度",
    pdfFallback: "页面没有显示时可以下载后查看：",
    tooLarge: "文件太大，暂时无法在面板内预览，请下载后查看。",
    unrenderable: "当前版本无法在面板内预览这种格式，请下载后查看。",
    sourceTruncated: "文件较长，这里只显示了开头部分。",
  },

  /** The 三维 structure view that opens for structure files. */
  molstar: {
    loading: "正在读入结构…",
    /** Shown when the plugin itself cannot start, a WebGL context included. */
    initFailed: "结构视图没能启动。",
    viewerAria: (name: string) => `${name} 的三维结构`,
    atoms: (count: number) => `${count} 原子`,
    /** The tooltip on both ways into the full-screen view, the thumbnail and the
     *  document's name above it, which are one switch. */
    expand: "放大到全屏",
    /** The ✕ in the corner of that view. Esc does the same thing. */
    close: "退出全屏",
  },

  /** 程序演进：一次在评分卡上自我改进的搜索。
   *
   *  The run card in the transcript and the full panel share this block; the
   *  words are written for the panel first and shortened for the card, so a
   *  search is called the same thing in both places. */
  evolve: {
    title: "程序演进",
    open: "程序演进",
    moreRuns: (count: number) => `还有 ${count} 个`,
    fewerRuns: "收起",
    /* 整张卡片是一个按钮，按下去打开的是右栏的任务面板，而不是就地展开；
       卡片因此把这件事写出来，不再只画一个像折叠箭头一样的记号。 */
    openPanel: "打开任务面板",
    /* 对话末尾那张运行卡片：等它启动，或者它已经跑了多久。分钟以下的搜索也
       要能看出在动，所以先报秒；一小时以上按设计稿写成「1小时28分钟」。 */
    notStarted: "尚未启动",
    working: "正在优化",
    elapsed: (seconds: number) => {
      const whole = Math.max(0, Math.floor(seconds));
      if (whole < 60) return `已耗时 ${whole}秒`;
      const minutes = Math.floor(whole / 60);
      if (minutes < 60) return `已耗时 ${minutes}分钟`;
      const rest = minutes % 60;
      return rest === 0
        ? `已耗时 ${Math.floor(minutes / 60)}小时`
        : `已耗时 ${Math.floor(minutes / 60)}小时${rest}分钟`;
    },
    autoPace: "自动",
    autoPaceTitle: "启动时未在每个检查点暂停",

    /* 检查点卡片。标题和正文是模型写在卡片里的内容，这里只有卡片自己的
       外壳：顶上那条带（等谁回答 + 第几步）、底下的两个按钮。 */
    checkpoint: {
      eyebrow: (step: number, total?: number) => (total === undefined ? `检查点 ${step}` : `检查点 ${step}/${total}`),
      /* 不等待审批的卡片不是检查点：没有人需要在这里做决定，它只是记录一步
         已经做完的事。所以它不叫「检查点」，也不带「自动」之类的角标。 */
      stepEyebrow: (step: number, total?: number) => (total === undefined ? `步骤 ${step}` : `步骤 ${step}/${total}`),
      /* 卡片顶上那条灰带分两段：左边说这张卡在等谁，右边是第几步。设计稿把
         「检查点」和「等待确认」排成一段字，中间不留空格。 */
      headerWaiting: "检查点等待确认",
      headerAnswered: "检查点已回答",
      headerStep: "步骤",
      count: (step: number, total?: number) => (total === undefined ? `${step}` : `${step}/${total}`),
      confirm: "确认，继续",
      adjust: "需要调整",
      /* 需要调整时，卡片里先写一句「调整内容」，下面的输入框是这一步要改的
         地方；输入框为空时按钮不亮。 */
      adjustLabel: "调整内容",
      adjustPlaceholder: "描述你想调整的内容，例如：这一步的评估标准再严一些。",
      /* 每张卡的确认都是同一句话时，模型只看到「继续」，分不清回答的是哪一步：
         一次跑动里它因此把检查点 3 重新问了一遍。把步号带出去，回复本身
         就说明了它答的是哪张卡。 */
      confirmReply: (step: number, total?: number) =>
        total === undefined ? `确认检查点 ${step}，继续。` : `确认检查点 ${step}/${total}，继续。`,
      /* 不需要审批时，卡片画完、模型却结束回合，整段设计就停在这一步。客户端
         替用户把流程推下去，发出的这句话只说明"第 N 步已记录，继续"，不是
         一次确认。 */
      autoContinue: (step: number, total?: number) =>
        total === undefined ? `继续步骤 ${step}。` : `继续步骤 ${step}/${total}。`,
      /* 没有卡片可续、回合却直接结束时（既没写检查点，也没调用
         create_evolve_run），同样由客户端推一次：整段设计停在半路，
         用户不在场，没有任何东西可以点。 */
      autoResume: "继续完成余下的检查点，并直接调用 create_evolve_run 启动搜索；在搜索启动前不要停下。",
      /* 同一步第二次结束时客户端不再续跑——再推就是为一个已经答过的卡片
         付费循环。这个停止必须写在卡片上：那一轮已经结束，画面上没有别的
         东西会动，不写出来就像设计自己卡死了。 */
      autoStopped: "已停止自动续跑",
      autoStoppedHint: "这一步已经自动续跑过一次，客户端不会为同一步再推一次；回复一句（例如「确认，继续」）即可让设计继续。",
      adjustDraft: "我想调整这一步：",
      busy: "这条回复还没结束，等它完成后再操作。",
    },

    create: {
      title: "新建程序演进实验",
      algorithmLabel: "选择搜索算法",
      puctName: "PUCT算法",
      puctTags: ["逐步改进", "搜索空间窄"],
      puctPoints: [
        "基于PUCT策略，优先扩展高潜力节点",
        "从根节点逐步拓展，保留全部候选方案",
        "结合访问次数与排名，引导搜索方向",
        "采用单树搜索，持续精炼候选方案",
      ],
      openEvolveName: "OpenEvolve算法",
      openEvolveTags: ["搜索空间宽", "避免过早收敛"],
      openEvolvePoints: [
        "MAP-Elites网格保留多样化优质候选",
        "多个种群独立进化，定期交换精英",
        "环形迁移促进优质方案跨种群传播",
        "变异参考全局最优与差异化候选",
      ],
      settingsLabel: "设置",
      confirmLabel: "检查点需要人工确认",
      confirmHint: "每个检查点会停下来等你确认后再继续",
      autoHint: "关闭后，助手会连续完成设计与启动；检查点仍会在对话中说明，但不再等待确认。",
      /* The task the design conversation starts from. It lives here as well as
         in the composer: the dialog is opened with a sentence already written,
         and the composer is where it can still be edited before sending. */
      taskLabel: "任务描述",
      taskPlaceholder: "待演进的任务详情，包含约束和评估标准，例如：写一对处理文本的压缩和解压代码，往返必须完全无损。分数是压缩后小了多少。",
      /* The name says what turning it on does — limit what the search may
         change — and the hint carries the other half: the starting values.
         “自定义 JSON” named the file format, which is an implementation detail
         nobody should have to decode before deciding. */
      parametersLabel: "自定义演进参数",
      parametersHint: "为参数设定起始值。勾选的参数会由演进自动尝试不同取值；未勾选的始终使用起始值。",
      /* Windows 没有 bwrap/seatbelt。这里不给开关，只给两处告警：标题下的
         横幅让人一眼看见，点“开始设计”时的弹窗索取逐次同意。同意只随这一次
         命令发出（`--allow-direct`），不成为会被忘记的设置。 */
      unisolatedBannerTitle: "此实验会在没有沙箱的情况下运行候选代码",
      unisolatedBannerBody: "这台机器没有可用的沙箱。候选代码会以你的身份直接运行：可以读写你的文件、访问网络，也没有CPU/内存限制。点击“开始设计”时会再确认一次。",
      unisolatedConfirmTitle: "允许无隔离运行候选代码？",
      unisolatedConfirmBody: "接下来会直接执行候选程序：没有沙箱、没有CPU/内存限制，可以读写你的文件并访问网络。只在你了解这些风险并愿意承担时继续。",
      unisolatedConfirmCancel: "取消",
      unisolatedConfirmClose: "关闭",
      unisolatedConfirmContinue: "仍然继续",
      send: "开始设计",
      cancel: "取消",
      blockedRunning: "当前会话正在运行，等它结束后再开始新的实验。",
      blockedSearch: "本会话已有正在运行的实验。请在对话中的卡片里打开它，或等它结束后再开始新的实验。",
      blockedArchived: "归档会话不能开始新的实验。",
    },

    /* 运行时不可用时的说明。桌面端的人只能看文件、点按钮，所以这里给的是
       这台机器上真实存在的路径和真实存在的操作，而不是“请联系支持”。 */
    setup: {
      bannerTitle: "优化进程不可用，可能导致无法得到预期结果",
      bannerInstalling: "优化进程正在准备，完成后即可开始设计",
      bannerAction: "查看详情",
      title: "演化运行时不可用",
      introMissing: "这台机器还没有安装演化运行时。装好之后，这个提示和“开始设计”会自动恢复。",
      introError: "演化运行时没能启动，或者本地服务没有通过它的认证。",
      introInstalling: "演化运行时正在准备中，完成后这个提示和“开始设计”会自动恢复。",
      statusLabel: "本地服务返回",
      whereTitle: "先看日志",
      logs: [
        {
          path: "%USERPROFILE%\\.sciencediscovery\\logs\\api.log",
          what: "本地服务的日志；安装或启动停在哪一步，末尾的报错会写出来。",
        },
        {
          path: "%USERPROFILE%\\.sciencediscovery\\logs\\evolve.log",
          what: "演化引擎自己的日志；引擎起来了却仍然不可用时看这里。",
        },
        {
          path: "%USERPROFILE%\\.sciencediscovery\\evolve",
          what: "运行时安装目录；目录缺失或文件不全，说明安装没有完成。",
        },
        {
          path: "<安装目录>\\logs\\shell.log",
          what: "桌面端启动日志，默认在 %LOCALAPPDATA%\\Programs\\ScienceDiscovery\\logs；应用连不上本地服务时看这里。",
        },
      ],
      whyTitle: "常见原因",
      whyBody: "第一次使用还没有安装；安装中途退出，或 evolve 目录被删除；代理或网络导致下载失败；磁盘剩余空间不足 1 GiB；部署没有开放自动安装。",
      fixTitle: "怎么恢复",
      fixBody: "点下面的“准备运行时”重新下载并安装。装过但已经损坏时，先退出应用，删除 %USERPROFILE%\\.sciencediscovery\\evolve，再重新安装。仍然失败时，对照 api.log 末尾的报错检查网络和磁盘，然后重启应用再试一次。",
      operator: "当前部署没有开放自动安装，请联系管理员在服务端启用程序演进；上面的状态和日志可以直接交给管理员。",
      installing: "正在准备…",
      install: "准备运行时",
      close: "关闭",
    },

    panel: {
      eyebrow: "程序演进",
      close: "关闭",
      stop: "停止",
      stopping: "正在停止…",
      /* 停止请求发出后到 run 真正落定之间，卡片要说明还在收什么，否则这几秒
         看起来像什么都没发生。不报具体个数：puct 和 openevolve 的 selected
         语义不同，且被丢弃的提案不会产生 expanded，事件日志里没有可信的
         “进行中候选数”，一个数会变成永远不减的假承诺。 */
      stoppingDetail: "正在结束进行中的候选…",
      stopHint: "停止后，已经产生的候选仍然可以查看。",
      fullscreen: "全屏",
      exitFullscreen: "退出全屏",
      fullTask: "查看完整目标",
    },

    status: {
      pending: "等待中",
      running: "运行中",
      succeeded: "已完成",
      stopped: "已停止",
      budget_exhausted: "预算用尽",
      failed: "失败",
    },

    /* 失败卡片只说「失败」时，用户无法判断是自己目标/评估写错，还是服务重启了。
       原因按机器可读的 code 翻译；没有记录原因的老记录明确说不知道。 */
    failure: {
      service_restart: "服务已重启，搜索被中断",
      sidecar_disconnected: "与搜索进程的连接中断",
      sidecar_unavailable: "搜索进程暂时不可用",
      search_failed: "搜索或评估失败",
      unknown: "未记录失败原因",
    },
    retry: "重试",
    retrying: "正在重试…",
    retryFailed: "重试失败，请稍后再试",

    metric: {
      best: "最优得分",
      baseline: "起点",
      test: "留出集测试",
      candidates: "候选",
      depth: "最大深度",
    },

    /* 任务详情：右栏「任务」页。版面照三张设计稿：顶部一排总览，下面依次是
       折线图、优化树和预算；节点列表和树是同一份数据的两种看法。 */
    detail: {
      best: "最优解",
      valid: "有效节点数/总数",
      generations: "层数",
      algorithm: "算法",
      tokens: "Token",
      chartTitle: "实时算法优化结果",
      treeTitle: "优化树",
      nodeList: "节点列表",
      generation: (depth: number) => `层数 ${String(depth).padStart(2, "0")}`,
      bestTag: "最佳",
      budgetTitle: "预算",
      score: "优化分数",
      children: "子节点数",
      source: "代码变更",
      expandSource: "展开代码变更",
      closeInspector: "关闭节点详情",
      closeSource: "关闭代码变更",
      nodeTitle: (index: number) => `Node #${index}`,
      root: "起点",
      treeEmpty: "还没有节点。",
      treeAria: (count: number) => `优化树，共 ${count} 个节点`,
    },

    chart: {
      title: "实时算法优化结果",
      aria: (baseline: string, best: string, candidates: number) =>
        `得分曲线：基线 ${baseline}，当前最优 ${best}，共 ${candidates} 个候选。`,
      xAxis: "扩展次数",
      best: "最优产物",
      significant: "得分节点",
      test: "测试",
      failed: "失败",
      belowBaseline: "低于基线",
      baseline: "基线",
      empty: "还没有可以画出的得分。",
    },

    inspector: {
      parent: "父代",
      depth: "深度",
      loading: "正在读取源码…",
      unavailable: "源码不可用（可能已被清理）。",
      unchanged: "与父代相同。",
      noParent: "这是起点，没有父代。",
      error: "失败原因",
      hidden: (count: number) => `已折叠 ${count} 行未改动内容`,
    },

    budget: {
      tokens: "Token",
      elapsed: "耗时",
      nodes: "节点",
    },

    notice: {
      placeholder: "这次实验的评分卡是占位符，不是为它设计的真实评分卡。",
    },
  },

  ideaTree: {
    heading: "Idea Tree 研究",
    empty: "这个会话还没有 Idea Tree 研究。",
    unavailable: "Idea Tree 服务尚未就绪：请先启动 Evolve 服务，再回来查看。",
    objective: "研究目标",
    legacyCard: "旧版假设树",
    legacyHint: "这条会话的树来自旧版本，只提供查看，不能在桌面端继续推进。",
    legacyCount: (nodes: number) => `${nodes} 个节点`,
    retry: "重试",
    endConfirm: "结束后不可恢复；树里已有的节点会保留。",
    status: {
      running: "进行中",
      pausing: "正在暂停",
      paused: "已暂停",
      interrupted: "已中断",
      completed: "已完成",
      ended: "已结束",
      budget_exhausted: "已结束（预算用尽）",
    },
    phase: {
      preflight_research: "准备研究",
      building_tree: "构建假设树",
      executing_leaf: "执行叶子",
      aggregating_score: "汇总评分",
      propagating_insight: "传播洞见",
    },
    round: (round: number) => `第 ${round} 轮`,
    batch: (done: number, total: number) => `本轮 ${done}/${total}`,
    tokens: (tokens: number) => `${tokens} tokens`,
    tokensUnknown: "token 用量未上报",
    reason: (reason: string) => IDEA_RESEARCH_REASONS[reason] ?? reason,
    budgetExhausted: (used: number | null, limit: number | null) => {
      const spent = used === null ? "已用 token 未上报" : `已用 ${used} tokens`;
      const cap = limit === null ? "未设置上限" : `上限 ${limit} tokens`;
      return `token 预算已用尽，研究已结束（${spent}，${cap}）。如需继续，请提高 token 上限后新建研究。`;
    },
    pause: "暂停",
    resume: "继续",
    end: "结束",
    open: "打开任务面板",
    create: {
      title: "启动 Idea Tree 研究",
      hint: "研究在后台自行推进；卡出现后点开即可看树、节点与控制。",
      taskLabel: "研究任务",
      taskPlaceholder: "一句话说明课题与验收边界",
      settingsToggle: "设置",
      settingsHint: "关闭时使用已保存的默认值。",
      start: "开始研究",
      starting: "正在启动…",
      cancel: "取消",
      failed: "启动失败。",
      unavailable: "Idea Tree 服务尚未就绪：请先启动 Evolve 服务，再回来重试。",
    },
    detail: {
      title: "节点详情",
      tree: "假设树",
      empty: "这棵研究树还没有节点。",
      unavailable: "不可用",
      notPruned: "未被剪枝",
      statusLabel: "状态",
      searchLabel: "检索",
      score: "评分",
      priority: "优先级",
      design: "设计",
      aggregate: "汇总",
      assessments: "评估",
      insight: "洞见",
      pruneReason: "剪枝原因",
      artifacts: "产物",
      status: {
        pending: "待执行",
        running: "执行中",
        done: "已完成",
        needs_retry: "需要重试",
        failed: "失败",
      },
      search: {
        active: "仍在检索",
        pruned: "已剪枝",
      },
      kind: {
        direction: "方向",
        candidate: "候选",
      },
    },
  },
  runFailure: {
    title: "运行失败",
    titles: {
      timeout: "运行超时",
      "rate-limited": "模型请求受限",
      "semantic-error": "运行异常",
      "server-error": "模型服务异常",
      "transport-error": "模型服务连接失败",
      unauthorized: "模型鉴权失败",
      "invalid-tool-call": "工具调用无效",
    },
    timeout: "运行已因超时终止。建议重试，或在系统设置中检查对应的超时设置。",
    timeoutNoticeTitle: "超时提示",
    timeoutNotice: "检测到超时，请展开技术详情确认受影响的操作，并检查对应的超时设置。",
    timeoutTitles: {
      gateway_idle: "运行超时",
      gateway_turn: "运行超时",
      permission_wait: "授权等待超时",
      runner_exec: "工具执行超时",
      kernel_idle: "内核空闲超时",
    },
    timeouts: {
      gateway_idle: (seconds: number) => `Agent 在 ${seconds} 秒内没有产生进展，运行已终止。建议重试，或在系统设置中适当增加 Agent 空闲超时时间。`,
      gateway_turn: (seconds: number) => `Agent 单轮运行已超过 ${seconds} 秒，运行已终止。建议拆分任务后重试，或在系统设置中适当增加单轮超时时间。`,
      permission_wait: (seconds: number) => `授权请求在 ${seconds} 秒内未得到处理，运行已终止。建议重试并及时处理授权请求，或在系统设置中适当增加授权等待超时时间。`,
      runner_exec: (seconds: number) => `工具执行已超过 ${seconds} 秒。建议缩小单次执行范围后重试，或在系统设置中适当增加执行超时时间。`,
      kernel_idle: (seconds: number) => `内核空闲时间已达到 ${seconds} 秒。建议重试，或在系统设置中适当增加内核空闲超时时间。`,
    },
    "rate-limited": "请求次数或用量已达到模型服务限制，运行已停止。建议稍后重试；若持续出现，请检查服务商的限额和可用额度。",
    // The backend uses semantic-error as a catch-all; do not assert a cause.
    "semantic-error": "运行中遇到了意外问题，任务未能完成。建议重试；若持续出现，请展开技术详情排查原因。",
    "server-error": "模型服务返回服务器错误，运行已停止。建议稍后重试；若持续出现，请检查服务状态或更换模型。",
    "transport-error": "无法连接模型服务，运行已停止。建议检查网络、代理设置及模型服务地址后重试。",
    unauthorized: "模型服务拒绝了当前凭据，运行已停止。建议在系统设置的模型注册表中检查 API Key 及访问权限后重试。",
    "invalid-tool-call": "模型生成的工具调用参数无法解析，该调用未执行，运行已停止。建议重试；若反复出现，可更换模型。",
    unknown: "任务未能完成，运行已停止。建议重试；若再次失败，请展开技术详情排查原因。",
    technicalDetails: "技术详情",
  },

  errors: {
    generic: "操作失败",
    sessionCreate: "创建会话失败",
    /** A response that claims to be an event stream but has no body. */
    noStream: "响应没有可读的流",
    modelUnavailable: "原模型已删除，请重新选择",
    modelSignInRequired: "积分模型需要登录华为账号后才能使用",
    modelRequired: "还没有可用的模型，请先在设置里配置。",
    rename: "重命名失败",
    deleteWarning: (title: string) => `删除「${title}」会连同它的工作区数据一起清掉，且无法恢复。`,
    archivedBanner: "这条会话已归档，处于只读状态。恢复后可以继续发消息与运行。",
    archivedComposer: "已归档的会话不能发消息，恢复后即可继续。",
    archiveBlockedByRun: "会话正在运行，等它结束后再归档或恢复。",
    archiveTearsDownKernel: "归档会停掉它在运行的科研内核，尚未落盘的内存不会随之恢复。",
    /** A Project takes its Sessions with it, so the sentence has to say so —
     *  deleting one Session is not what the reader is agreeing to. */
    deleteProjectWarning: (name: string) =>
      `删除项目「${name}」会连同它下面的所有会话、工作区和产物一起清掉，且无法恢复。`,
  },

  status: {
    localOnline: "本地运行时 · 在线",
    localDegraded: "本地运行时 · 降级",
    localOffline: "本地运行时 · 离线",
  },

  /** 用户反馈：填表、历史与回执。与 Web 端共用同一份共享层契约。 */
  feedback: {
    entry: "我要反馈",
    dialogTitle: "提交反馈",
    selectPlaceholder: "请选择",
    requiredHint: "出现频率和影响程度为必填项",
    close: "关闭",
    tab: {
      compose: "填写反馈",
      history: "我的反馈",
    },
    kind: {
      label: "类型",
      bug: "遇到问题",
      idea: "有想法",
      other: "其他",
    },
    body: {
      label: "描述",
      placeholder: "请描述你遇到的情况或想法（10–2000 字）",
      counter: (count: number, max: number) => `${count}/${max}`,
      tooShort: (min: number) => `请至少写 ${min} 个字`,
    },
    contact: {
      label: "联系方式（可选）",
      placeholder: "邮箱或 GitHub 用户名",
      invalid: "这看起来不像邮箱或 GitHub 用户名",
    },
    reproducibility: {
      label: "出现频率",
      always: "总是出现",
      sometimes: "偶尔出现",
      once: "只出现一次",
    },
    impact: {
      label: "影响程度",
      blocker: "无法使用",
      major: "影响工作效率",
      minor: "影响使用体验",
    },
    diagnostics: {
      label: "附带诊断信息",
      preview: "预览将要发送的内容",
      none: "本条反馈没有可用诊断信息",
    },
    images: {
      label: "截图（可选）",
      add: "上传图片",
      limit: (max: number) => `最多 ${max} 张`,
      remove: "移除截图",
      preparing: "正在处理图片…",
      truncated: (max: number, skipped: number) => `只附加了前 ${max} 张截图，另有 ${skipped} 张被跳过。`,
      privacy: "截图对仓库协作者可见，请先遮挡敏感信息。",
      error: {
        type: "仅支持 PNG、JPEG 或 WebP 图片。",
        size: "图片压缩后仍然过大，请换一张。",
        decode: "无法读取这张图片。",
      },
    },
    submit: "提交",
    submitting: "提交中…",
    success: {
      title: "感谢你的反馈",
      note: "以下是你的回执码，我们用它向你更新处理进展。",
      copyReceipt: "复制回执码",
      copied: "已复制",
      done: "完成",
    },
    failure: {
      network: "无法连接反馈服务，内容已保留。",
      timeout: "请求超时，内容已保留。",
      forbidden: "服务拒绝了这次请求。",
      rateLimited: "你提交得太频繁了，请稍后再试。",
      duplicate: "这条内容你已经提交过了。",
      tooLarge: "内容太长，请精简后再试。",
      unavailable: "服务暂时不可用，请稍后再试。",
      invalid: "部分字段需要检查。",
      fieldsTitle: "需要检查的字段",
      kept: "内容已保留，你可以复制或改用 GitHub 提交。",
      copyAll: "复制全部内容",
      openIssue: "改用 GitHub 提交",
    },
    back: "返回",
    history: {
      empty: "还没有提交过反馈",
      delete: "删除",
      status: {
        submitted: "已提交",
      },
    },
    pii: {
      warning: (kinds: string) => `正文中可能包含个人信息（${kinds}）。请删除或确认可以提交。`,
      confirm: "我确认可以提交",
      phone: "手机号",
      idCard: "身份证号",
      email: "邮箱",
    },
  },
};

/** The shape every language must fill. */
export type Text = typeof ZH;
