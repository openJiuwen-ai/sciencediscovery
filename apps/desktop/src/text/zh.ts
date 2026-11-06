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
 * Every user-visible string, in one place — Simplified Chinese.
 *
 * This dictionary is also the shape of the interface: `Text` is `typeof ZH`,
 * so the English dictionary cannot grow or lose a key without the compiler
 * saying so. Wording is reviewable here without reading any JSX.
 */
export const ZH = {
  researchPackage: {
    continueUnavailable: "此导入记录尚未完整恢复，暂不能继续聊天。请查看导入省略项并恢复缺失服务后重新导入。", sourceUnavailable: "会话或所属项目已不存在。请刷新会话列表后重试。",
    projectDestination: "项目归属", noProject: "无项目", projectDestinationHint: "默认放入「会话」，也可以选择一个已有项目。", necessaryContents: "会话记录 · 当前文件与产物 · 依赖证据", completeContents: "会话记录 · 文件与产物版本 · 已有研究历史",
    newOptions: "新建会话选项", projectImport: (name: string) => `在「${name}」中导入会话`, messageMenu: "回复菜单", sessionScope: "导出整个会话及其研究材料，不只是页面上的聊天文字。", packageContents: "包含会话、工作区文件、产物及相关研究证据。",
    title: "科研证据包", import: "导入会话", export: "导出会话", continue: "继续聊天", branch: "创建新分支聊天", source: "返回来源会话",
    readOnly: "导入证据快照 · 只读。创建独立副本后，可使用已有材料继续研究。", copying: "正在复制研究记录，可切换会话…", ready: "研究副本已准备好", failed: "操作失败", open: "打开会话", download: "下载", preparing: "正在后台准备证据包…", close: "关闭", copyMissing: "复制任务对应的会话或操作记录已不存在，已停止等待。请重新创建续聊。", copyPollingFailed: "暂时无法读取复制进度，已停止重试。请稍后刷新或重新操作。",
    necessary: "必要导出", complete: "完整导出", necessaryHint: "保留当前结果、输入依赖与相关证据，精简可选历史。", completeHint: "保留所选范围内的已有历史和版本。", trajectory: "包含完整轨迹详情", graph: "包含完整科学记忆图谱", estimate: "预计大小（未压缩）", calculating: "正在计算范围与大小…", files: "工作区文件", omissions: "范围与省略说明", evidenceOnly: "证据包用于检查和继续研究；导入不会执行代码或恢复历史授权。", choose: "选择 .sdresearch 研究包", objects: "个内容对象", importHint: "恢复会话、文件和研究证据，并准备可继续聊天的会话。原始记录保留不变。", branchHint: "新分支保留所选回复及之前的对话与可恢复研究证据，不包含之后的内容；原会话保持不变。", reply: "分支起点", working: "正在处理…", startExport: "开始后台导出", confirmImport: "确认导入",
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
  },

  /** The narrow icon rail down the left edge. */
  rail: {
    task: "会话",
    settings: "设置",
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
    showMore: "显示更多",
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
    confirm: "确认",
    cancel: "取消",
  },

  composer: {
    placeholder: "需要帮你做些什么？输入“/”快速引用技能及指令",
    /** After a design command is seeded the composer is no longer waiting for
     *  any request: the only useful next line is the goal itself. */
    evolvePlaceholder: "请描述你想要优化的对象和评估标准",
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
    experts: "专家",
    expertsNone: "无",
    expertsHint: "为此对话绑定一位个人专家。",
    expertsSearch: "请输入关键字搜索",
    expertsEmpty: "没有匹配的专家。",
    expertsLoading: "正在读取专家…",
    /** The `/` palette's name, for its listbox role. */
    skillsPalette: "选择技能",
    permission: "请求批准",
    permissionMode: "权限模式",
    permissionAskShort: "询问",
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
    copyAnswer: "复制回答",
    copied: "已复制",
    /** The system-notice kinds the transcript can carry. */
    notices: {
      timeout_notice: "超时",
    } as Record<string, string>,
    /** Fills in a cancellation whose reason the stream did not carry. */
    cancelledReason: "运行已取消",
    thinking: "思考过程",
    thinkingSteps: (count: number) => `${count} 步`,
    /** The folded line standing in for a run that has not finished yet. */
    thinkingNow: "正在规划下一步",
    /**
     * The same line once the run is over. Minutes and seconds are the units a
     * wait is actually felt in; an hour is where "72 分" stops being readable,
     * and the seconds are dropped there because by then they are noise.
     */
    elapsed: (ms: number) => {
      const seconds = Math.max(1, Math.round(ms / 1000));
      if (seconds < 60) return `用时 ${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `用时 ${minutes} 分 ${seconds % 60} 秒`;
      return `用时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    },
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
      items: {
        api: "本地 API 服务",
        runner: "执行引擎（Python 运行环境）",
        model: "默认任务模型（可选，可稍后在设置中配置）",
      },
      notChecked: "未检查",
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
    testOk: (latency: number) => `✓ 连接成功（${latency} ms）`,
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
      save: "保存",
      default: "主模型",
      empty: "还没有配置模型。没有模型就无法发送消息。",
      setDefault: "设为主模型",
      defaultFailed: "没能把这个模型设为默认，请重试。",
      test: "测试连接",
      testFailed: (message: string) => `✕ ${message}`,
      testOk: (latency: number) => `✓ 可用（${latency} ms）`,
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
      heading: "技能",
      jiuwenSwarmOnly: "当前执行器不是 JiuwenSwarm，技能开关不可用。",
      noProject: "还没有可用的项目，无法读取技能选择。",
      off: "已停用",
      on: "已启用",
      scope: "这里的开关控制 JiuwenSwarm 的全局技能状态，适用于使用其技能机制的新任务。ScienceDiscovery 技能包在首次启用时导入。",
      toggle: (name: string) => `启用或停用「${name}」`,
      add: "新增技能",
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
      instructionsHeading: "指令",
      instructionsLoading: "正在读取指令…",
      instructionsFailed: "没有读到指令。",
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
        skills: { label: "技能", description: "创建、启用或停用技能" },
        mcp: { label: "MCP 服务器", description: "管理内置与自定义 MCP 服务，选择会话默认使用的工具来源" },
        specialists: { label: "专家", description: "可复用的指令与工具组合" },
        "sandbox-network": { label: "网络", description: "run_shell 的网络访问" },
        remote: { label: "远程", description: "远端 Runner 与项目可用机器" },
        timeouts: { label: "超时", description: "墙钟限制与不限模式" },
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
        argsHint: "以空格分隔。",
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
        tested: (status: string) => `测试结果：${status}`,
        saved: "MCP 服务器已保存",
        deleteTitle: (name: string) => `删除服务器「${name}」？`,
        deleteBody: (name: string) => `删除「${name}」后依赖它的工具不再可用，已经跑完的结果不受影响。`,
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
        treeHeading: "默认值",
        template: "模板",
        intensity: "探索强度",
        quick: "快速",
        standard: "标准",
        deep: "深入",
        rounds: "最多轮次",
        candidates: "每轮候选数",
        maxDepth: "最大深度",
        maxNodes: "最大节点数",
        maxSearchRounds: "最大检索轮次",
        maxTokens: "单次调用最大 token",
        direction: "评分方向",
        maximize: "最大化",
        minimize: "最小化",
        promptsHeading: "提示词",
        promptHint: "留空则使用模板默认值。",
        designPrompt: "设计提示词",
        aggregatorPrompt: "汇总提示词",
        propagatePrompt: "洞见传播提示词",
        weight: "权重",
        assessorPrompt: "评估提示词",
        criteria: "评分标准",
      },
      specialists: {
        heading: "专家",
        help: "专家是可复用的指令与工具组合，任务可以指派给它们。",
        empty: "还没有专家。",
        builtIn: "内置",
        enabled: "已启用",
        disabled: "已停用",
        editTitle: "编辑专家",
        name: "名称",
        namePlaceholder: "例如：RNA-seq 审查员",
        description: "描述（可选）",
        descriptionPlaceholder: "显示在列表中的简短描述",
        instructions: "指令",
        instructionsHint: "附加在应用的基础提示词之后，不会替换安全规则或工具说明。可选填。",
        instructionsPlaceholder: "可选 —— 留空则原样使用基础提示词。",
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
        defaultHint: "没有单独设置的模块都按它来解析。",
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
        urlStored: "已保存地址",
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
        gatewayTurnHint: "一轮对话允许的最长时间。",
        kernelIdle: "内核空闲超时",
        kernelIdleHint: "持久内核闲置多久后回收。",
        permissionWait: "授权等待超时",
        permissionWaitHint: "等待用户批准的最长时间。",
        runnerExec: "执行超时",
        runnerExecHint: "沙箱里一次代码执行的最长时间。",
        seconds: "秒",
        unlimited: "不限",
        saved: "已保存",
      },
      quotas: {
        heading: "配额",
        help: "到达上限后写入会被拒绝。把某一项设为不限，它就不受配额限制。",
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
        gib: "GiB",
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
    modelRequired: "还没有可用的模型，请先在设置里配置。",
    rename: "重命名失败",
    deleteWarning: (title: string) => `删除「${title}」会连同它的工作区数据一起清掉，且无法恢复。`,
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
