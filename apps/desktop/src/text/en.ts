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
 * Every user-visible string, in English.
 *
 * Typed as `Text`, which is the Chinese dictionary's shape: a missing or
 * misspelled key is a compile error rather than a blank label at runtime.
 * Placeholders and units stay in step with `zh.ts` by construction.
 */

import type { PermissionDescriptionRenderers } from "@sciencediscovery/schema";

import type { Text } from "./zh.js";

/** in the Session workspace / in subagent X. */
function permissionScope(subagentId: string | undefined): string {
  return subagentId ? `in subagent ${subagentId}` : "in the Session workspace";
}

/** Run a shell script on build-01 in the Session workspace. */
function permissionWhere(remoteHostAlias: string | undefined, subagentId: string | undefined): string {
  return `${remoteHostAlias ? `on ${remoteHostAlias} ` : ""}${permissionScope(subagentId)}`;
}

/**
 * The approval sentence, composed from the request's structured description
 * (#1305). Wording here never comes from the server: the API has no Session
 * locale, so the client is the only place that knows the reader's language.
 */
const PERMISSION_DESCRIPTIONS: PermissionDescriptionRenderers = {
  shell: ({ remoteHostAlias, subagentId }) => `Run a shell script ${permissionWhere(remoteHostAlias, subagentId)}`,
  python: ({ remoteHostAlias, subagentId }) => `Run Python code ${permissionWhere(remoteHostAlias, subagentId)}`,
  language: ({ language, remoteHostAlias, subagentId }) => `Run ${language} code ${permissionWhere(remoteHostAlias, subagentId)}`,
  "file-copy": ({ fileCount }) => `Copy ${fileCount} selected files between authorized Workspaces`,
  npu: ({ operation, subject, subagentId }) => operation === "run"
    ? `Run host NPU workload ${subject} ${permissionScope(subagentId)}`
    : `Cancel host NPU job ${subject} ${permissionScope(subagentId)}`,
  "direct-host": ({ account, command, cwd, runnerId, subagentId, target, workspaceRoot }) =>
    `DIRECT HOST EXECUTION: Runner ${runnerId}, ${target}, account ${account}, workspace ${workspaceRoot}, cwd ${cwd || "."}`
    + `${subagentId ? `, subagent ${subagentId}` : ""}. No sandbox filesystem, process or network isolation; host credentials may be accessible.`
    + ` Host effects cannot all be tracked or rolled back. Matching consent covers only this exact command and scope during this Agent run, with no fixed TTL.`
    + ` Approval does not execute. Command:\n${command}`,
  "specialist-runtime": ({ runtime, workspaceRoot }) =>
    `Run ${runtime} directly on the API host in ${workspaceRoot}. This removes the outer sandbox for this task; platform tools retain their own permissions.`,
  network: ({ hosts, purpose, runnerId }) =>
    `Sandbox network on ${runnerId} for this Agent run: ${hosts.join(", ")}. Purpose: ${purpose}.`,
  environment: ({ environmentId, language, manager, name, operation, runnerId }) => {
    const runner = runnerId ? ` on Runner ${runnerId}` : "";
    switch (operation) {
      case "create": return `Create named ${language ?? ""} environment ${name ?? environmentId ?? ""}${runner}`;
      case "delete": return `Delete named environment ${environmentId ?? ""}${runner}`;
      case "install": return `Install ${manager ?? ""} packages in named environment ${environmentId ?? ""}${runner}`;
      case "setup": return `Set up scientific environments on the selected Runner${runner}`;
      case "uninstall": return `Uninstall packages from named environment ${environmentId ?? ""}${runner}`;
    }
  },
  "workspace-sync": ({ direction, paths, runnerId }) => `${direction} Runner ${runnerId}: ${paths.join(", ")}`,
  "skill-publish": ({ proposalCount, subagentId }) => subagentId
    ? `Publish ${proposalCount} Skill Library proposal(s) from subagent ${subagentId}`
    : `Publish ${proposalCount} Skill Library proposal(s) in this Session`,
  "mcp-tool": ({ recovered, sourceId, toolId }) => `Call ${recovered ? "repaired " : ""}MCP tool ${sourceId}/${toolId}`,
  "artifact-download": ({ name, path }) => `Download ${name} to workspace path ${path}`,
  "remote-job": ({ command, hostAlias, mode }) => `Run ${mode.toUpperCase()} job on ${hostAlias}: ${command}`,
  web: ({ hostname, operation, query }) => operation === "fetch"
    ? `Fetch public web content from ${hostname ?? ""}`
    : `Search the public web for “${query ?? ""}”`,
  "tool-call": ({ detail, toolName }) => {
    const call = `Run ${toolName ? `tool ${toolName}` : "a tool call"} in this Session`;
    // The arguments being approved are shown verbatim: run_shell's resource is
    // the fixed workspace-code, so the command appears nowhere else.
    return detail ? `${call}\n${detail}` : call;
  },
};

/**
 * The same units as the Chinese dictionary: a wait is felt in seconds, then
 * minutes, and an hour is where the smaller units stop being readable. The
 * finished span and the live clock share it so they only differ in their
 * opening word.
 */
function runSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Large counts the way English reads them: 15K, 24M, 1.5B.
 *
 * This is the counterpart of the Chinese table's 万 scale (#1394): the unit is
 * part of the sentence, so each dictionary states its own. Both switch at
 * 10 000, below which the plain grouped number is clearer in either language.
 */
function compactCount(value: number): string {
  if (value < 10_000) return Math.round(value).toLocaleString("en-US");
  const tiers = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const;
  for (const [divisor, unit] of tiers) {
    const scaled = value / divisor;
    // A value that would print as four digits belongs to the next unit up (or,
    // above B, to the plain grouped number) — never to "1000K".
    if (scaled < 1 || scaled >= 999.5) continue;
    const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    return `${rounded}${unit}`;
  }
  return Math.round(value).toLocaleString("en-US");
}

export const EN: Text = {
  configurationLegacy: {
    title: "Enable connector", awaiting: "Awaiting confirmation", change: "Change", scope: "Scope", session: "This session only",
    continuation: "Original task", noTask: "No task was submitted", recorded: "Continuation recorded by the server", serverOwned: "Continuation is managed by the server",
    enable: (name: string) => `Enable ${name}`, userReason: (name: string) => `You requested access to ${name}.`, taskReason: (name: string) => `The original task requested ${name}.`,
    confirm: "Confirm and enable", decline: "Not now", saving: "Saving…", saved: "Saved", dismissed: "Not configured", stale: "Request out of date",
    dismissedDetail: "This connector was not enabled by this request.", staleDetail: "The settings or original task changed. This request cannot be applied.",
    countdown: (seconds: number) => `Previously authorized automatic configuration is due in ${seconds}s.`, due: "Waiting for the server to review the previously authorized automatic change.",
    waitRun: "Wait for the current task to reach a safe pause before deciding.", failed: "The decision could not be confirmed. Refresh its status before trying again.", refresh: "Refresh status",
  },
  researchPackage: {
    continueUnavailable: "This imported record is not fully restored and cannot be continued. Restore the missing services and import again.", sourceUnavailable: "The conversation or its project no longer exists. Refresh the session list and try again.",
    projectDestination: "Project", noProject: "No project", projectDestinationHint: "Added to Sessions by default. You may choose an existing project.",
    projectImport: (name: string) => `Import conversation into ${name}`, messageMenu: "Reply menu", packageContents: "Conversation, workspace files, artifacts and related research evidence.",
    title: "Research package", import: "Import conversation", export: "Export conversation", continue: "Continue chatting", branch: "Create branch chat", source: "Return to source",
    readOnly: "Imported evidence · Read-only. Create an independent copy to continue with the retained materials.", copying: "Copying research in the background…", failed: "Operation failed",
    recalculating: "Recalculating…",
    omissionsSummary: (count: number) => `Not included: ${count} workspace file${count === 1 ? "" : "s"}`, download: "Download", preparing: "Preparing the package in the background…", close: "Close", copyMissing: "The conversation or operation record for this copy no longer exists; waiting has stopped. Create a new continuation.", copyPollingFailed: "Unable to read copy progress; retries have stopped. Refresh or try again later.", legacyUnavailable: "The local service is temporarily unavailable, retrying…", exportPollingFailed: "Unable to read export progress; retries have stopped. Export again later.", exportMissing: "The export task no longer exists. Export again.",
    exportDownloadStartTimeout: "Timed out waiting for the evidence package download to start. Check your connection and try again.",
    exportDownloadStalled: "The evidence package download stalled. Check your connection and try again.",
    necessary: "Necessary", recordsBytes: "Record data", retryPreview: "Recalculate size", previewRetrying: "Still calculating the size…", pendingLong: "The size preview is taking unusually long. Recalculate it, or cancel and try again later.", detailsRaw: "Technical details", taskMissing: "That export task no longer exists. Export again.", taskExpired: "The exported file has expired. Export again.", taskRestarted: "The export was still running when the service restarted. Export again.", complete: "Complete", exportTypes: "Export type", badgeConversation: "Conversation", badgeCurrentFiles: "Current files", badgeDependencies: "Dependencies", badgeFileVersions: "File versions", badgeHistory: "Existing history", selectAll: "Select all", filesWithCount: (count: number) => `Workspace files (${count})`, otherContent: "Also include", readOnlyTitle: "Read-only snapshot", readOnlyBadge: "Read only", contextFrom: "Context from", dropHint: "Drop or choose a research package", necessaryHint: "Keeps the conversation, the current files and the required dependencies", completeHint: "Includes every file, historical version and research record", graph: "Include the full scientific memory", estimate: "Estimated size", estimateUncompressed: "Uncompressed estimate", calculating: "Calculating scope and size…", sizeLimit: (size: string) => `Uncompressed limit: ${size}`, overLimit: (size: string, limit: string) => `This selection is ${size} uncompressed, over the ${limit} limit. Switch to the necessary export, or deselect the largest workspace files.`, overLimitNecessaryOnly: "The necessary export is already the smallest scope: only exporting anyway, or deselecting workspace files, can make it fit.", overLimitRisk: "Exporting anyway reads the whole scope and compresses it in memory: it can take a long time and may exhaust this machine's memory.", exportAnyway: "Export anyway", overLimitConfirmed: "Over-limit export confirmed. The package will exceed the documented limit.", packageTooLarge: "This research package is over the size limit this build accepts. If you exported it, export again with a smaller scope; if someone sent it to you, ask them for a smaller export.", evidenceOnly: "Packages support inspection and continuation. Import does not execute code or restore permission grants.", choose: "Select a .sdresearch package", objects: "content objects", importOmissions: (count: number) => `Not included: ${count} item${count === 1 ? "" : "s"}`, omissionText: {
          family: { artifact: "Artifact", cas: "Package object", evolve: "Evolution search", review: "Review record", run: "Run", trajectory: "Trajectory entry", version: "File version", workspace: "Workspace file" },
          hint: { artifact: "A version of this artifact was not carried in the package.", cas: "The package references object content that is missing.", evolve: "The evolution search's candidate trees, scores or budgets were not carried.", review: "A review record could not be written or read while packaging.", run: "The record of this run is incomplete.", trajectory: "A trajectory entry of this session could not be read.", version: "The original content of a file version is missing.", workspace: "A workspace file's content could not be read or is missing.", unparsed: "The package manifest carries this entry, but it is not readable text." },
          unrepresentable: "unrepresentable value",
          unparsed: (raw: string) => `${raw} (not readable text)`,
        }, importHint: "Restore conversation, files and evidence as a read-only snapshot. Continuing research creates an independent new session. The original record is preserved.", branchHint: "Choose a completed reply. The branch inherits the prefix and recoverable evidence, excluding later research.", reply: "Branch starting point", working: "Working…", startExport: "Start export", cancelAction: "Cancel", chooseFile: "Choose a file", reselect: "Choose another", confirmImport: "Import", exportSaving: "Saving package…", exportSaved: "Package saved", exportSaveFailed: "Failed to save the package", exportCanceled: "Export canceled", openLocation: "Open file location", exportsInProgress: (count: number) => `${count} export${count === 1 ? "" : "s"} in progress`, retrySave: "Retry save", savedExports: "Saved packages",
  },
  /** Export history: the study packages this machine has saved, reachable again
   *  after the export dialog closed or the app restarted (#1154). */
  exportHistory: {
    title: "Export history",
    description: "Study packages saved on this machine, findable again",
    empty: "No study package has been saved yet.",
    noMatch: "No saved package matches the current filter.",
    unavailable: "Export history is available inside the desktop app only.",
    searchPlaceholder: "Search by filename or session",
    allProjects: "All projects",
    missing: "File moved or deleted",
    reveal: "Show in folder",
    forget: "Remove record",
    revealMissing: "The file was moved or deleted; you can remove this record.",
  },
  /** Session management: archiving moves a Session out of the sidebar, and this
   *  is where it goes — read-only while it waits, back to 活跃 with restore, and
   *  deleted for good only through the same confirmation the ⋯ menu uses. */
  sessionManagement: {
    title: "Session management",
    description: "Archived sessions, to restore or delete for good",
    empty: "No Session is archived.",
    noMatch: "No Session matches the current filter.",
    loading: "Reading the archived Sessions…",
    unreachable: "A project could not be read, so this list may be incomplete.",
    searchPlaceholder: "Search sessions",
    allProjects: "All projects",
    archivedAt: (when: string) => `Archived ${when}`,
    readOnly: "Read-only while archived — restore it to carry on",
    open: "Open",
    restore: "Restore",
    remove: "Delete for good",
  },
  appName: "ScienceDiscovery",
  languageTag: "en-US",

  boot: {
    checking: "Connecting to the local service…",
    offlineTitle: "Cannot reach the local service",
    offlineBody:
      "The local service did not respond. Make sure ScienceDiscovery is running, then try again.",
    retry: "Retry",
    noTokenTitle: "Credential required",
    noTokenBody:
      "Paste the access link from the startup output (it ends in #token=…) into the address bar, or paste the credential itself.",
    tokenLabel: "Access credential",
    tokenPlaceholder: "Paste the access credential",
    tokenSubmit: "Continue",
    rejectedTitle: "Credential not accepted",
    rejectedBody:
      "The local service rejected this credential. Copy the full access link from the startup output again.",
    localConnected: "The local service credential was accepted.",
  },

  login: {
    brandTitle: "Ask better questions. Run better research.",
    brandTagline: "Plan, execute and trace scientific work in one workbench — with a credit grant so you can try it before committing to anything.",
    benefitCredits: "500 credits on your first sign-in",
    benefitNoCard: "No card and no subscription — credits only",
    benefitByok: "Point it at your own model endpoint whenever you like",
    privacy: "Sign in with HUAWEI ID. We store the account identifier, display name and any email HUAWEI shares.",
    title: "Account sign-in",
    subtitle: "Signing in with HUAWEI ID grants credits you can spend on the free model. Click the sign-in button below to continue to the HUAWEI account page to sign in (this application does not access or retain the HUAWEI ID phone number).",
    huaweiButton: "Continue with HUAWEI ID",
    skipToModel: "Skip for now and configure a custom model",
    entering: "Entering the workspace…",
    redirecting: "Waiting for HUAWEI ID…",
    verifying: "Confirming your session…",
    errorTitle: "Sign-in did not complete",
    errorBody: "HUAWEI ID returned an error, or the account service could not verify the code. Try again.",
    accountServiceMissing:
      "This build has no account service address, so HUAWEI ID sign-in is unavailable. Ask whoever built the app to set VITE_ACCOUNTS_API and rebuild.",
    localTokenMissing: "Sign-in completed, but this machine's access credential could not be issued. Check that the local service is running and try again, or sign out.",
    retry: "Try again",
    accountTab: "HUAWEI ID",
    modelTitle: "Custom model setup",
    modelEnter: "Save and enter the workspace",
  },

  account: {
    eyebrow: "HUAWEI ID",
    back: "Back to sessions",
    joined: (days: number) => `Joined ${days} days ago`,
    emailReadonly: (email: string) => `Email ${email}`,
    available: "Available credits",
    creditsUnit: "credits",
    tokenEstimate: "Approx. tokens",
    tokensUnit: "tokens",
    tokenCount: compactCount,
    conversations: "Conversations",
    conversationsUnit: "turns",
    earned: "Total earned",
    spent: "Total spent",
    todayEarned: "Earned today",
    rewardTitle: "Today's reward",
    rewardToday: "Today's sign-in reward received: +100 credits",
    rewardPending: "Received automatically after sign-in",
    day: (day: number) => `Day ${day}`,
    rewardHint: (days: number) => `${days} more consecutive days unlock the 7-day +50 bonus`,
    ledgerTitle: "Credit activity and spending",
    ledgerCapped: (rows: number) => `Showing the latest ${rows} rows; older activity is no longer listed.`,
    filter: { all: "All", earned: "Earned", spent: "Spent" },
    ledgerEmpty: "No credit activity yet.",
    biz: {
      REGISTER: "Sign-up bonus",
      CHECKIN: "Daily check-in",
      BONUS: "7-day check-in bonus",
      LLM_USAGE: "Model usage",
      ADMIN: "Manual adjustment",
      REFUND: "Refund",
    },
    afterBalance: (balance: string) => `Balance ${balance}`,
    perPage: "Rows per page",
    perPageUnit: "",
    pageCurrent: (page: number) => `Page ${page}`,
    pageOf: (page: number, total: number) => `Page ${page} / ${total}`,
    prevPage: "Previous",
    nextPage: "Next",
    jumpTo: "Go to",
    jumpUnit: "",
    jump: "Go",
    model: "Model",
    input: "Input",
    cached: "Cached",
    output: "Output",
    latency: "Latency",
    tokensTotal: "Total tokens",
    usageTitle: "Last 5 days",
    calls5: (count: number) => `${count} calls`,
    spent5: (credits: string) => `${credits} credits spent`,
    tokens5: (tokens: string) => `${tokens} tokens`,
    usageFoot: (average: string, model: string) => `Average ${average} credits per call · Most used ${model}`,
    devicesTitle: "Signed-in devices",
    currentDevice: "Current",
    signedInAt: (time: string) => `Signed in ${time}`,
    revokeDevice: "Sign out",
    deviceRevoked: "Signed out that device",
    deviceRevokeFailed: "Could not sign out that device. Try again.",
    profileTitle: "Name and account",
    displayName: "Display name",
    nameHint: "1–24 characters. Saving updates the sidebar and this page.",
    nameInvalid: "The display name must be 1–24 characters",
    email: "Email (read-only)",
    emailHint: "The email comes from HUAWEI ID and cannot be changed here.",
    save: "Save name",
    saveShort: "Save",
    editName: "Edit name",
    saved: "Display name saved",
    saveFailed: "Could not save. Try again.",
    rulesTitle: "Credit rules",
    rulesBody: "The first sign-in grants 500 credits; each day's first sign-in grants 100; every 7 accumulated check-ins adds 50. The token estimate is illustrative; actual usage is settled from model usage.",
    signOut: "Sign out",
    signOutTitle: "Confirm signing out of your HUAWEI account",
    signOutBody: "The HUAWEI credit model becomes unavailable after signing out.",
    loadFailed: "Could not load the account. Try again later.",
  },

  /** The narrow icon rail down the left edge. */
  rail: {
    task: "Sessions",
    settings: "Settings",
    user: "User",
  },
  sidebar: {
    title: "Research sessions",
    githubStar: "Star this project on GitHub",
    newTask: "New session",
    project: "Projects",
    /** The standalone-conversation section, and the title the app shows
     *  wherever a Session outside a Project has to name one. */
    recent: "Sessions",
    noRecent: "No sessions",
    noProjects: "No projects yet",
    newProject: "New project",
    projectName: "Project name",
    /** Said under the name field when another Project already has that name;
     *  the service refuses the same name with a 409. */
    projectNameTaken: (name: string) => `A project named "${name}" already exists`,
    /** The `+` on a Project fold; the name is in it because a column of
     *  identical buttons is not distinguishable to a screen reader. */
    newSessionInProject: (name: string) => `New session in ${name}`,
    projectMenu: "Project menu",
    noTasks: "No sessions yet",
    /** The fold control's label: how many older Sessions pressing it reveals,
     *  computed from the list itself so the tail never reads as deleted. */
    showMore: (count: number) => `Show ${count} older ${count === 1 ? "Session" : "Sessions"}`,
    /** The rule a folded Project states above its page: the newest N are shown. */
    pageRule: (count: number) => `Latest ${count}`,
    collapseSidebar: "Collapse sidebar",
    expandSidebar: "Show sidebar",
    renameHint: "Double-click to rename",
  },

  sessionBar: {
    workspaceToggle: "Workspace panel",
    sessionMenu: "Session menu",
    sessionTitle: "Session name",
    renameHint: "Double-click to rename",
    untitled: "Untitled session",
  },

  menu: {
    rename: "Rename",
    delete: "Delete",
    archive: "Archive",
    restore: "Restore",
    confirm: "Confirm",
    cancel: "Cancel",
  },

  composer: {
    placeholder: "What can I help you with? Type “/” to reference a skill or instruction",
    /** After a design command is seeded the composer is no longer waiting for
     *  any request: the only useful next line is the goal itself. */
    evolvePlaceholder: "Describe what you want to optimize and how it should be scored",
    /** Shown under an Idea Tree token, which asks for a research task rather
     *  than a design goal. */
    ideaTreePlaceholder: "Describe the question to research and how to judge it",
    send: "Send",
    stop: "Stop",
    /** The ✕ on the design command token; the dialog only suggested it. */
    clearCommand: "Remove command",
    modelSelect: "Choose a model",
    addCustomModel: "Add a custom model",
    pillLocked: "You can switch models when this run finishes",
    stopHint: "Closing the page or reloading will not stop the run. Stop it here explicitly.",
    uploadFile: "Upload files",
    sessionSettings: "Session settings",
    /** The action at the top of 会话设置: the way into program evolution. */
    evolveExperiment: "Program evolution experiment",
    ideaTree: "idea-tree",
    experts: "Experts",
    expertsNone: "None",
    expertsHint: "Bind a personal expert to this conversation.",
    expertsDisabled: "Disabled",
    boundExpertDisabledHint: "Disabled for new selections; this session keeps its binding. Choose None to stop using it in subsequent turns.",
    expertsSearch: "Search by name",
    expertsEmpty: "No matching experts.",
    expertsLoading: "Loading experts…",
    /** The `/` palette's name, for its listbox role. */
    skillsPalette: "Choose a skill",
    permission: "Ask for approval",
    permissionMode: "Permission mode",
    permissionAskDesc: "Always ask before editing external files or using the internet",
    permissionFull: "Full access",
    permissionFullDesc: "Access the internet and any file on your computer without restriction",
    permissionLocked: "You can change permissions when this run finishes",
    attachHint: (limit?: string) => limit === undefined
      ? "Files go into this session's workspace, where the agent can read them. You can also drag files onto the window."
      : `Files go into this session's workspace, where the agent can read them. A single file may be up to ${limit}. You can also drag files onto the window.`,
    attachArchived: "This session is archived and cannot be written to. Restore it before uploading.",
    /** Composer placeholder while the JiuwenSwarm cluster starts. */
    jwBlocked: "The agent cluster is starting. Chat unlocks when it is ready…",
  },

  ideaTreeOverride: {
    title: "Idea Tree parameters",
    hint: "Confirming applies these values to this conversation and puts the Idea Tree command in the composer; add the research task and send. The change applies to this conversation only and leaves the global defaults alone; only Overwrite the global settings writes them back.",
    /** Beside a field: the deployment value it inherits, so the reader can see
     *  what 确认 would write and what releasing a pin means. */
    globalValue: (value: string) => `Global: ${value}`,
    /** Badge on a field whose draft differs from the deployment value. */
    overridden: "Overridden",
    template: "Research template",
    templateGeneral: "General scientific hypothesis",
    templateWater: "Water-treatment materials",
    intensity: "Exploration intensity",
    quick: "Quick",
    standard: "Standard",
    deep: "Deep",
    direction: "Score direction",
    maximize: "Maximize",
    minimize: "Minimize",
    maxDepth: "Maximum depth",
    maxNodes: "Maximum nodes",
    saveSession: "Confirm",
    pinned: "This conversation pins some parameters; the others still follow the global settings.",
    saveGlobal: "Overwrite the global settings",
    cancel: "Cancel",
    loading: "Reading…",
    savedSession: "This conversation will use these settings",
    confirmSend: "Confirm",
    savedGlobal: "Written to the global settings",
    unchanged: "Nothing was changed here, so the global settings are untouched.",
    noSession: "Open a conversation to change the settings for it alone.",
  },
  /** Reviewer Specialist: the session's own toggle, and the review card the
   *  conversation draws at its checkpoint. */
  reviewer: {
    title: "Review",
    settings: "Auto-review",
    unavailable: "The Reviewer Specialist is off, so automatic review will not run for this session.",
    level: "Review level",
    /** Shown on the level row when automatic review is off: the level is not
     *  idle, a manual run still reads it. */
    levelManualHint: "Automatic review is off; Review now will still use this level.",
    levelQuickDesc: "Deterministic checks: structure, citation format, delivery completeness.",
    levelDeepDesc: "Adds source-by-source and computation evidence checks on top of Quick.",
    running: "Reviewing…",
    /** The stage the coordinator is in, when it says. It is what tells a
     *  reader that a long Deep review is working rather than stuck. */
    phase: {
      quick: "Running the quick checks",
      preparing: "Preparing the review…",
      computation: "Checking the computation evidence",
      citation: "Checking the citations",
    } as Record<string, string>,
    summaryPass: "No issues found",
    summaryFindings: (count: number) => `${count} ${count === 1 ? "issue" : "issues"}`,
    /** A warning is not a revision request; its row and badge say Warning. */
    summaryWarnings: (count: number) => `${count} ${count === 1 ? "warning" : "warnings"}`,
    summaryFindingsAndWarnings: (critical: number, warnings: number) =>
      `${critical} ${critical === 1 ? "issue" : "issues"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
    summaryContradicted: "Contradicted",
    summaryPartlySupported: "Partly supported",
    summaryIncomplete: "Delivery incomplete",
    summaryUnverified: "Delivery unverified",
    summaryFailed: "Review failed",
    summarySkipped: "Review skipped",
    /** Nothing was raised, but the review itself said part of the claim was
     *  never examined. "No issues found" alone would read as a pass. */
    summaryPartial: (count: number) => `No issues found, but ${count} ${count === 1 ? "check was" : "checks were"} not run`,
    checks: (count: number) => `${count} ${count === 1 ? "check" : "checks"}`,
    /** One checkpoint can cover several artifacts; when their verdicts differ,
     *  the header's worst-of phrase would hide the clean ones. */
    outcomeCounts: (passed: number, attention: number) => `${passed} passed · ${attention} need attention`,
    checkNames: {
      structure: "Structure",
      citation: "Citation",
      computation: "Computation",
      completeness: "Completeness",
    } as Record<string, string>,
    /** What a category means, for the label above each claim. The label is one
     *  word ("Computation"), which is not enough to know what was compared
     *  with what. */
    labelTips: {
      structure: "Structure: checks the artifact's fields, format and provenance are complete. It does not judge whether the content is right.",
      citation: "Citation: checks the citation identifiers can be recognised and are well formed. It does not check whether the cited work supports the claim.",
      computation: "Computation: compares the numbers in the report with the evidence, checking the figures and the statistics agree.",
      completeness: "Completeness: checks every declared deliverable is present and not empty.",
      semantics: "Semantics: Deep review reads the cited source text and decides whether the claim is supported. Deep reviews only.",
      other: "General finding: not tied to one check, recorded during the review.",
      gaps: "Not checked: this review did not run this check, and the reason is below. Not checked is not a pass.",
      source: "Source verification: compares one claim with the source text and answers supported, partly supported, contradicted or inconclusive.",
    } as Record<"structure" | "citation" | "computation" | "completeness" | "semantics"
      | "other" | "gaps" | "source", string>,
    checkPass: (name: string) => `${name} passed`,
    passBody: "Nothing was found wrong with this check.",
    finding: "Issue",
    warning: "Warning",
    badgePass: "Pass",
    /** For a check that ran but could not conclude, or a delivery verdict no brief declared. */
    badgeUnconfirmed: "Unconfirmed",
    deepSemantic: "Semantics",
    source: "Source",
    gaps: "Not checked",
    gapChecks: {
      claim_support: "Claim support",
      citation_identity: "Citation identity",
      computation: "Computation",
    } as Record<string, string>,
    /** What the unperformed check would have covered, in the card's language.
     *  The server's own reason is an English template and is only the fallback
     *  for a check this map does not know. */
    gapBodies: {
      claim_support: "This review did not check the claims against their sources. Use Deep review to check that.",
      citation_identity: "This review did not check the papers' identity (authors, journal, year).",
      computation: "This review did not check the numbers against the computation evidence.",
    } as Record<string, string>,
    /** The claim-support gap as a Deep review leaves it. Asking the reader to
     *  run a Deep review again would contradict the level they just chose. */
    deepGapBodies: {
      inconclusive: "Deep review did try to check the claims against their sources but could not reach a verdict (enough source text may have been unavailable, or the excerpt may not clearly support or contradict the claim), so this check still counts as not performed. That does not mean the report is wrong.",
      noComparison: "Deep review found no claim it could compare with a source, so this check still counts as not performed.",
    },
    gapBodyUnknown: "This review did not run this check.",
    /** A citation-format-only Quick pass did not look at claim support. */
    citationOnlyNote: "This review checked citation format only; claim support was not checked.",
    /** Why a checkpoint produced nothing, by the server's reason code. */
    skipReasons: {
      specialist_disabled: "The Reviewer Specialist is off, so no review was produced.",
      automatic_review_disabled: "Automatic review is off for this session, so no review was produced.",
    } as Record<string, string>,
    skipUnknown: "No review was produced.",
    stale: "A newer version of this artifact exists, so this review is history.",
    outdated: " (outdated)",
    rerun: "Re-run review",
    rerunQueued: "Queued for review.",
    /** Ask for a review of the Session's current report-shaped artifacts
     *  without waiting for a new version to make the old verdict stale. */
    runNow: "Review now",
    stopRun: "Stop review",
    runStarted: "Review started.",
    runStopped: "Review stopped.",
    noCheckpoint: "There is no checkpoint to review again.",
    reused: "Reused the verdict for the same version",
    completeness: {
      complete: "Delivery complete",
      incomplete: "Delivery incomplete",
      unconfirmed: "No deliverable list declared",
      sourceBrief: "Checked against the deliverables this task declared.",
      sourceSession: "This task declared nothing; checked against the session's own declarations.",
      sourceNone: "No deliverable declaration was available, so delivery could not be confirmed.",
      missing: "Missing",
      empty: "Empty",
    },
    assessments: {
      SUPPORTED: "Supported",
      PARTIALLY_SUPPORTED: "Partly supported",
      CONTRADICTED: "Contradicted",
      INCONCLUSIVE: "Inconclusive",
    } as Record<string, string>,
    progress: (completed: number, total: number) => `${completed}/${total}`,
    queued: (count: number) => `${count} queued`,
    /** A bounded passage in a locked source; "locator" and evidence levels
     *  are internal vocabulary, so the card says what was found instead. */
    locators: (count: number) => `${count} source excerpt${count === 1 ? "" : "s"}`,
    sourceInconclusiveWith: (count: number) => count === 1
      ? "Found 1 source excerpt, but it is not enough to decide whether this claim holds."
      : `Found ${count} source excerpts, but not enough to decide whether this claim holds.`,
    sourceInconclusiveNone: "No source excerpt was found to judge this claim.",
    failedDetail: "The review reported an error.",
    empty: "This checkpoint produced no review record.",
    noReviews: "No reviews yet.",
    tab: "Review",
    levelName: (level: string): string => (level === "quick" ? "Quick" : "Deep"),
    levelPill: (level: string): string => (level === "quick" ? "Quick" : "Deep"),
    /** The pill only names the level; the tip carries what the name claims.
     *  The two levels differ in whether the cited source text is read. */
    levelTip: (level: string): string => (level !== "quick"
      ? "Deep review: on top of the Quick checks, reads the cited source text and evidence to verify each claim against its source."
      : "Quick review: deterministic structure, citation-format and delivery checks on this machine; no source text is read."),
  },

  /** The bottom-right banner while the JiuwenSwarm cluster is still starting
   *  (the shell bridge pushes progress; this is the idle wording). */
  jiuwen: {
    starting: "Agent cluster starting",
    preparing: "Initializing…",
  },

  upload: {
    dropTitle: "Drop to upload",
    dropBody: (limit?: string) => limit === undefined
      ? "The files go into the workspace, where the agent can read them."
      : `The files go into the workspace, where the agent can read them. A single file may be up to ${limit}.`,
    archived: "This session is archived and cannot be written to.",
    readOnly: "This session is read-only and cannot be written to.",
    unlimited: "unlimited",
    busy: "Uploading…",
    tooLarge: (name: string, limit: string) => `${name} exceeds ${limit} and was not uploaded.`,
    tooMany: (max: number) => `A message holds at most ${max} attachments.`,
    failed: (name: string, reason: string) => `${name}: ${reason}`,
  },

  /** The cards the composer holds: one per file, from the moment it is chosen
   *  until the message that carries it is sent. */
  attachment: {
    uploading: "Uploading…",
    failed: "Upload failed",
    retry: "Retry",
    remove: (name: string) => `Remove ${name}`,
    delete: "Delete",
    clear: "Clear attachments",
    /** The line under the name once the upload landed. */
    detail: (type: string, size: string) => (type === "" ? size : `${type} ${size}`),
    tray: "Attached files",
  },

  conversation: {
    configurationRefreshFailed: "Configuration requests could not refresh. The displayed state may be out of date; retry before confirming.",
    retryConfiguration: "Retry",
    copyAnswer: "Copy answer",
    usage: {
      label: "Usage", heading: "Usage this turn", models: "Models", input: "Input", output: "Output",
      cacheRead: "Cache read", cacheWrite: "Cache write", reasoning: "Reasoning",
      unreported: "Not reported", incomplete: "Includes reported usage only; actual usage may be higher.",
      loading: "Loading usage…", failed: "Could not load usage.", retry: "Retry",
    },
    copied: "Copied",
    notices: {
      timeout_notice: "Timeout",
      configuration_notice: "Configuration update",
      wake_notice: "Interruption recovery",
    },
    cancelledReason: "The run was cancelled",
    /** Explains an automatic wake that follows an interrupted run, so the
     *  second run in the transcript is not a silent duplicate. */
    interruptedResume: (attempt: number) => `The previous run did not reach a completed state; this automatic wake is attempt ${attempt}. It only reports the interruption and background notifications and does not redo the interrupted task. See the run record for why it stopped.`,
    interruptedRun: (runId: string) => `Interrupted run: ${runId} (still marked as interrupted)`,
    thinking: "Reasoning",
    thinkingSteps: (count: number) => `${count} ${count === 1 ? "step" : "steps"}`,
    thinkingNow: "Planning the next step",
    workingTool: (name: string) => `Running ${name}`,
    workingSubagent: (task: string) => `Subagent working: ${task}`,
    elapsed: (ms: number) => `Worked for ${runSpan(ms)}`,
    elapsedNow: (ms: number) => `Elapsed ${runSpan(ms)}`,
    expand: "▸ Expand",
    collapse: "▼ Collapse",
    running: "Generating",
    queued: "Queued",
    blocked: "Waiting for approval",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    truncatedThinking: "This reasoning is long; only part of it is shown.",
    truncatedBody: "This content is long; only part of it is shown.",
    droppedEvents: (count: number) =>
      `${count} earlier ${count === 1 ? "event" : "events"} could not be replayed; the recoverable part is below.`,
    unknownEvents: (count: number) =>
      `Skipped ${count} ${count === 1 ? "event" : "events"} this version does not recognise.`,
    /** Updates the live run sent that could not be read. The run carried on
     *  without them, so the turn may be missing a part. Deliberately plain
     *  language: no protocol or format names reach the user. */
    malformedFrames: (count: number) =>
      `Skipped ${count} ${count === 1 ? "update" : "updates"} that could not be read.`,
    streamEnded: "The connection ended and the run's state is unknown. Reload to fetch it again.",
    emptyTurn: "This turn produced no text.",
    toolCall: "Tool call",
    toolRunning: "Tool is running…",
    loadingResult: "Loading the full result…",
    noOutput: "The tool finished with no output.",
    toolInput: "Input",
    toolOutput: "Output",
    toolError: "Error",
    openInPanel: "Open in panel",
    toolCompleted: (name: string) => `Called ${name}`,
    toolFailed: (name: string) => `Call failed: ${name}`,
    inputTruncated: "The input was truncated by the retention policy.",
    outputTruncated: "The output was truncated by the retention policy.",
    authorized: "Approved",
    resultUnavailable: "The result is temporarily unavailable.",
    uploads: {
      more: (count: number) => `${count} more ${count === 1 ? "file" : "files"}`,
      rest: "The other uploaded files",
    },
  },

  /** What one assistant turn produced, under the answer that produced it (#1252). */
  turnArtifacts: {
    title: "Produced this turn",
    updated: "Updated",
    more: (count: number) => `${count} more`,
    openPanel: "Open artifact panel",
    version: (value: number) => `v${value}`,
    kinds: {
      dataset: "Dataset", figure: "Figure", html: "Page", json: "JSON", latex: "LaTeX",
      markdown: "Document", notebook: "Notebook", other: "File", report: "Report", structure: "Structure",
    },
  },
  subagent: {
    lineLabel: "Subagent",
    status: {
      running: "Running",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      timed_out: "Timed out",
    },
    detail: "Execution",
    output: "Output",
    task: "Task",
    inputFiles: "Input files",
    emptySteps: "This subagent has not recorded any execution to show yet.",
    loading: "Loading the execution record…",
    stale: "The execution record is not refreshing, so what is shown may be behind.",
    thinking: "Reasoning",
    tool: "Tool",
    turns: (count: number) => `${count} ${count === 1 ? "turn" : "turns"}`,
    tokens: (count: number) => `${count} tokens`,
    failedTitle: "Execution failed",
    timedOutTitle: "Execution timed out",
    cancelledTitle: "Execution cancelled",
  },

  landing: {
    tagline: "SCIENCE, EXPLORED",
    placeholder: "What can I help you with…",
    clearCategory: "Clear category",
    projectDirectory: "Choose project",
    chooseProject: "Choose a project",
    noProject: "Don't work in a project",
    noProjectNote: "The session will appear under Sessions",
    categories: {
      research: "Literature",
      experiment: "Experiments",
      analysis: "Data analysis",
    },
    topics: {
      research: [
        { label: "State of the field", prompt: "Search and summarize the research on methods for detecting microplastics in water over the last three years: the main approaches, representative work, and what is still open." },
        { label: "Key techniques", prompt: "Survey the key techniques for extracting natural products, such as ultrasound-assisted extraction and supercritical CO₂, and compare when each applies, their strengths and limits, with representative papers." },
        { label: "Recent papers", prompt: "Find the important papers published recently on plant-derived natural antioxidants such as tea polyphenols and anthocyanins, group them by theme, and state each one's contribution." },
        { label: "Competing approaches", prompt: "Analyze how the leading teams or products in probiotic formulations approach the problem, and compare their trade-offs." },
      ],
      experiment: [
        { label: "Controlled design", prompt: "Design a controlled experiment on cell proliferation inhibition for me: the treatment and control groups, variable control, number of replicates, and the metrics." },
        { label: "Antioxidant assay", prompt: "Design an experiment to measure how well tea polyphenols scavenge free radicals: the reagents and equipment needed, how to group the samples, the steps, and the metrics." },
      ],
      analysis: [
        { label: "Proteomics", prompt: "Walk me through a proteomics analysis pipeline, from raw mass-spec files to a list of differentially abundant proteins: the input at each step, the usual tools, and the quality-control points to watch." },
        { label: "Single-cell sequencing", prompt: "Plan a single-cell sequencing analysis: quality control, clustering, cell annotation, and differential expression." },
      ],
    },
  },

  guide: {
    label: "Interface guide",
    step: (index: number, total: number) => `Step ${index} of ${total}`,
    skip: "Skip",
    back: "Back",
    next: "Next",
    done: "Start using it",
    steps: {
      composer: {
        title: "The composer",
        body: "Write what you need in the box in the middle and press Enter to send. The + on the left attaches files, the picker on the right chooses the model and the permission mode, and typing / references a Skill or a command directly. The first message turns this page into a conversation.",
      },
      settings: {
        title: "Settings",
        body: "“Settings” in the narrow left rail opens the configuration panel: models, Skills, MCP servers, specialists and networking all live there, and every change applies at once — there is nothing to save.",
      },
      panel: {
        title: "The right panel",
        body: "The workspace panel on the right lists the artifacts and files this session produces; open one to preview it. Drag the divider on its left to widen it, or use the button in its header to collapse it.",
      },
    },
  },

  /** Scientific memory: the citations in a final report, and the card behind
   *  one that says what it is and where it came from. There is deliberately
   *  no graph here. */
  memory: {
    title: "Scientific memory",
    loading: "Reading scientific memory…",
    closeDialog: "Close",
    openChip: "See this citation's details and provenance",
    openSettings: "Open scientific memory settings",
    notFoundTitle: "This memory was not found",
    notFoundBody: "Nothing in memory matches this record. It may have been deleted, or the memory service may be unavailable right now.",
    disabledTitle: "Scientific memory is off",
    disabledBody: "Turn it on in Settings → Scientific memory and a report's citations expand into their evidence and artifacts.",
    unreachableTitle: "Scientific memory is unavailable",
    unreachableBody: "The memory service did not answer. Try again in a moment.",
    errorTitle: "Could not read memory",
    retry: "Retry",
    previewTab: "Preview",
    provenanceTab: "Provenance",
    contentLabel: "Evidence content",
    sourceExcerpt: "Source excerpt",
    chipLabels: {
      evidence: "Evidence",
      artifact: "Artifact",
      sourcefile: "File",
      dbrecord: "Record",
      session: "Session",
      skill: "Skill",
    },
    status: {
      healthy: "Running",
      degraded: "Cannot connect",
      checking: "Checking",
      unknown: "Status unknown",
      recheck: "Check again",
    },
    field: {
      evidenceType: "Evidence type",
      locator: "Locator",
      confidence: "Confidence",
      source: "Source",
      recordedAt: "Recorded",
      name: "Name",
      version: "Version",
      mediaType: "Media type",
      path: "Path",
      session: "Session",
      hash: "Content hash",
    },
    version: (version: number) => `v${version}`,
    nodeLabels: {
      Artifact: "Artifact",
      Claim: "Claim",
      Code: "Code",
      DbRecord: "Database record",
      Evidence: "Evidence",
      Paper: "Paper",
      ResearchGoal: "Research goal",
      SearchCell: "Search cell",
      SearchNode: "Candidate",
      SearchRun: "Evolution run",
      SourceFile: "Uploaded file",
      Task: "Task",
      ToolCall: "Step",
      WebPage: "Web page",
    },
    provenance: {
      loading: "Reading provenance…",
      error: "Provenance could not be read.",
      retry: "Retry",
      noAbstract: "No abstract recorded.",
      sourcesEmpty: "No source paper, file, or web page was recorded.",
    },
    /** The evidence's source file follows the old UI's inline preview: PDFs in
     *  a frame, images inline, everything else behind a download link. */
    evidenceSource: {
      loadingFile: "Reading the file preview…",
      fileMissing: (name: string) => `${name} could not be found.`,
      fileFailed: "The file preview could not be read.",
      downloadFile: (name: string) => `Download ${name}`,
      unknownType: "Unknown type",
    },
    openArtifactFailed: "The artifact could not be opened.",
    artifactMissing: "The artifact panel has no record of this artifact.",
    /** The artifact dialog follows the old web UI: version and download in
     *  the header, 预览 / 溯源 as the two tabs. */
    artifactDialog: {
      previewTab: "Preview",
      versionLabel: "version",
      versionOf: (version: number, total: number) => `v${version} of ${total}`,
      updatedInSession: (session: string) => `Updated in Session ${session}`,
      versionSource: (session: string) => `Source: ${session}`,
      deletedSession: "Deleted Session",
      download: "Download current version",
      downloadFailed: "Could not download artifact",
      // The dialog is on screen from the press; this is what its body says
      // until the version's bytes arrive.
      loading: "Opening artifact…",
      versionAria: "Artifact version",
    },
    /** An Artifact's provenance is the old web UI's provenance tab: parents,
     *  code, execution log, and the managed environment of the run. */
    artifactProvenance: {
      dependencies: "upstream file",
      code: "Code",
      downloadScript: "Download script",
      execution: "Execution log",
      exitCode: (code: number | null) => `exit ${code ?? "unavailable"}`,
      workingDirectory: "Working directory",
      unavailable: "unavailable",
      stdoutEmpty: "stdout: empty",
      environment: "Managed package environment",
      noPackages: "No packages recorded",
      sourceSessionDeleted: "The source Session was deleted. Artifact content and version history are retained; Session execution details are unavailable.",
      processEnvironment: (count: number) => `Process environment (${count} variable${count === 1 ? "" : "s"})`,
      processEnvironmentEmpty: "No environment variables recorded.",
      processEnvironmentUnavailable: "Process environment unavailable (not recorded for this run).",
    },
  },

  permission: {
    required: "Permission required",
    allowOnce: "Allow once",
    allowMatching: "Allow this kind",
    deny: "Deny",
    details: "Details",
    action: "Action",
    resource: "Resource",
    requested: "Requested",
    decision: "Decision",
    decided: "Decided",
    execution: "Execution",
    toolCall: "Tool call",
    actions: {
      artifact_download: "Download an artifact",
      code: "Run local code",
      connector: "Use a connector",
      direct_code: "Execute directly on the host (no sandbox)",
      directory: "Access a directory",
      host: "Connect to a host",
      remote_job: "Run a remote job",
      sandbox_network: "Sandbox network access",
    },
    description: PERMISSION_DESCRIPTIONS,
  },

  wizard: {
    title: "Choose a model provider",
    sub: "Choose the platform that serves your AI models; you'll add the model and credentials next.",
    art: {
      title: "AI Workbench",
      sub: "Finding better solutions",
    },
    workspace: {
      title: "Set up your research workspace",
      sub: "Artifacts, intermediate results and logs all land in this directory, in one place.",
      label: "Workspace directory",
      placeholder: "Choose or enter a directory path",
      browse: "Browse for a directory",
      useDefault: "Use the default location",
      note: "This only records the location you pick: the shell fixes the live data directory at launch, so changing this does not move existing data.",
      check: {
        writable: "✓ Directory is writable",
        notWritable: "✗ Directory is not writable (check permissions or antivirus)",
        freeUnknown: "⚠ Cannot read the disk's free space",
        free: (size: string) => `✓ ${size} free (5 GB recommended)`,
        freeLow: (size: string) => `✗ Only ${size} free; 5 GB is required`,
      },
      skip: "Skip and use the default",
      next: "Next",
    },
    boot: {
      title: "Preparing the environment",
      sub: "The first launch prepares the runtime (Python and its dependencies). This can take several minutes to a quarter of an hour, depending on disk speed and antivirus software.",
      starting: "Starting the local service…",
      waited: (seconds: number) => `Starting the local service… (${seconds}s elapsed)`,
      hint: "You can minimise the window while it starts; the first-time preparation is not interrupted.",
      checkingTitle: "Checking key components",
      checkingSub: "Once everything passes, you can configure a model.",
      readyTitle: "The environment is ready",
      readySub: "The key components passed; continue to configure a model to start using the app.",
      failedTitle: "Preparing the environment ran into a problem",
      failedSub: "Check the logs and try again; antivirus software may be blocking the preparation.",
      timeoutTitle: "Some components are not ready",
      timeoutSub: "The execution engine may be slow on its first preparation; wait a moment and check again.",
      fallbackError:
        "Unknown reason. Check the logs and try again; antivirus software may be blocking the preparation.",
      /* [U5c] The Seatbelt keys of this block (items.seatbelt,
         seatbeltFailedTitle/RetryHint/NotApplicable/OptInTitle) are retired
         with the wizard's Seatbelt row and banner: sandbox health lives in
         设置 › 连接 › 沙箱网络's status row alone (owner decision 2026-11-23). */
      items: {
        api: "Local API service",
        runner: "Execution engine (Python runtime)",
        model: "Default task model (optional; can be configured later in settings)",
      },
      notChecked: "Not checked",
      runnerNeedsToken: "Not checked (token required)",
      retry: "Check again",
      retryBoot: "Try again",
      logs: "Open the logs folder",
      next: "Next: choose a model",
    },
    back: "Back",
    optional: "Optional",
    provider: {
      baseUrl: "Base URL",
      apiKey: "API key",
      apiKeyPlaceholder: "Enter an API key",
      reveal: "Show",
      conceal: "Hide",
      model: "Model name",
      modelPlaceholder: "e.g. deepseek-chat",
      fetch: "Refresh list",
      fetching: "Refreshing…",
      fetchHint: "Read the provider's model list. You can also type a model name yourself.",
      choose: "Choose a model",
      noMatch: (query: string) =>
        `No model matches "${query}". You can still type the name yourself.`,
      empty: "The provider returned no models. Check the base URL and the key.",
      preset: "Provider type",
      tokenOptional: "Local service; optional",
    },
    custom: {
      option: "Custom (enter the address yourself)",
      name: "Custom gateway",
      protocol: "API protocol",
      protocols: {
        "anthropic-messages": "Anthropic Messages",
        "openai-chat-completions": "OpenAI Chat Completions",
        "openai-responses": "OpenAI Responses",
      },
    },
    testAndContinue: "Test and continue",
    retest: "Test again",
    finish: "Start using",
    testing: "Testing…",
    testOk: (latency: number) => `✓ Basic check passed (${latency} ms)`,
    // A pass proves the provider answers one minimal request — nothing about
    // the session run path, thinking, or tool use (issue #824).
    basicCheckNotice: "Basic check only: it does not verify the full session run path, thinking, or tool use.",
    missingKey: "Enter an API key first.",
    missingModel: "Choose or enter a model name first.",
    testCategories: {
      authorization: "The key was rejected. Check that it matches the chosen provider.",
      invalid_response:
        "The address responded, but not in a model API's format — the base URL is probably wrong.",
      missing_token: "This provider requires an API key.",
      network: "Cannot reach this address. Check the network or that the custom address is reachable.",
      not_found:
        "The endpoint returned 404. Check whether the base URL is missing or has an extra path segment.",
      ok: "Connected.",
      provider_error: "The provider returned an error. Try again later.",
      rate_limited: "Rate limited; the key itself works.",
      timeout: "The connection timed out.",
    },
    saveFailed: (message: string) => `Save failed: ${message}`,
  },

  settings: {
    close: "Close settings",
    general: {
      language: {
        heading: "Language",
        field: "Interface language",
        english: "English",
        // A language names itself: the Chinese option has to be readable to
        // someone who cannot yet read the page it sits on.
        chinese: "简体中文",
      },
      guide: {
        heading: "Interface guide",
        field: "Interface tour",
        action: "Replay",
      },
    },
    loading: "Loading…",
    retry: "Retry",
    edit: "Edit",
    /** The pair above 技能 / MCP 服务器 / 专家's lists, which writes every row
     *  of the list at once. */
    enableAll: "Enable all",
    disableAll: "Disable all",
    saveFailed: "Save failed. Try again.",
    cancel: "Cancel",
    model: {
      add: "Add model",
      addHint: "Pick a provider, enter its address and key, then choose a model from the list it reports.",
      save: "Save",
      default: "Primary",
      empty: "No models yet. Without a model you cannot send messages.",
      setDefault: "Set as primary",
      defaultFailed: "Could not make this the default model. Try again.",
      test: "Test connection",
      testFailed: (message: string) => `✕ ${message}`,
      testOk: (latency: number) => `✓ Basic check passed (${latency} ms)`,
      testOkNotice: "Basic check only: it does not verify the full session run path, thinking, or tool use.",
      requiresSignIn: "Sign-in required",
      delete: "Delete",
      deleteConfirm: (name: string) => `Delete the model "${name}"?`,
      deleteBody: "Sessions explicitly using this model will need a new selection. Historical runs are preserved.",
      replacement: "New primary model",
      leaveUnset: "Leave unset",
      deleteFailed: "Could not delete this model. Try again.",
      expand: "Expand model settings",
      name: "Model name",
      nameHint: "Shown in this list and in a session's model menu.",
      nameRequired: "The name cannot be empty.",
      nameFailed: "Could not save the model name. Try again.",
      cancel: "Cancel",
      pickHint: "Choose from the models the provider reports; the pick is saved as soon as you make it. A model another entry already uses cannot be picked again.",
      switchFailed: "Could not switch this model. Try again.",
      addedOption: "Added",
      providerRefresh: "Refresh list",
      providerRefreshHint: "Ask the provider for its model list again instead of using the cached copy.",
      refreshing: "Reading…",
      saving: "Saving…",
      providerSource: "Provider response",
    },
    skills: {
      detail: "Details",
      empty: "No skills found.",
      search: "Search skills",
      searchPlaceholder: "Search skills…",
      /** The × inside the search field that puts the whole list back. */
      clearSearch: "Clear search",
      noMatches: "No skills match your search.",

      heading: "Skills",
      jiuwenSwarmOnly: "The current agent backend is not JiuwenSwarm, so skill switches are unavailable.",
      noProject: "No project is available, so skill choices cannot be read.",
      off: "Off",
      on: "On",
      toggle: (name: string) => `Enable or disable "${name}"`,
      installedCount: (count: number) => `${count} installed`,
      /** The three tabs above the list. The count is part of the label, as in
       *  the handoff: every row the tab holds, not only those matching the
       *  current search. */
      tabs: {
        label: "Skill categories",
        all: (count: number) => `All skills (${count})`,
        mine: (count: number) => `My skills (${count})`,
        official: (count: number) => `Official skills (${count})`,
        basic: "Overview",
        files: "Files",
      },
      /** The way out of a package's own page. */
      back: "Back",
      /** 技能详情: the package's files on the left, one of them open on the right. */
      fileTree: {
        list: "Files",
        reading: "Reading the file…",
        copy: "Copy",
        download: "Download",
        copied: "Copied",
      },
      /** The tag on a card: a package that ships with the app, or one the user
       *  brought in. */
      cardTag: {
        builtIn: "Built-in",
        external: "External",
      },
      /** A category the user opened that holds no rows at all. */
      emptyScope: "No skills in this category yet.",
      /** The list's own subtitle. The directory's entry keeps the shorter line
       *  it uses as a tooltip; this page says what the page itself does. */
      listDescription: "Manage and install the skills agents can use",
      /** The native save dialog a Skill export opens. */
      exportDialog: {
        title: "Export Skill",
        filterName: "Skill ZIP",
        buttonLabel: "Save",
      },
      /** The one press that adds a Skill, and the three ways to do it. The
       *  hint is the second line of each entry: the three labels are short
       *  enough to look alike, and what differs is where the package comes
       *  from. */
      addMenu: {
        label: "Add skill",
        scratch: "Write from scratch",
        upload: "Upload skills",
        git: "Import from GitHub",
      },
      backToList: "Back to skills",
      createView: {
        title: "Write from scratch",
        description: "The name becomes the skill ID. The new package can be edited from the list afterwards.",
      },
      create: "Create",
      name: "Name",
      namePlaceholder: "For example, literature-review",
      nameHint: "Lowercase letters, digits, and hyphens only; this becomes the skill ID.",
      nameInvalid: "The name may contain only lowercase letters, digits, and single hyphens.",
      description: "Description",
      descriptionPlaceholder: "Say what this skill does and when to use it.",
      instructions: "Instructions",
      instructionsPlaceholder: "Write the steps, decision criteria, and output format. This becomes the body of SKILL.md.",
      license: "License",
      licensePlaceholder: "Optional, for example MIT",
      version: "Version",
      versionPlaceholder: "Optional, for example 1.0.0",
      compatibility: "Compatibility",
      compatibilityPlaceholder: "Optional, for example: needs Python 3.11 and network access",
      /** A skill that declared no version is still described by the revision it
       *  is installed at; the word carries it, so the card does not print the
       *  server's `revision:1` after a `v`. */
      revision: (revision: number) => `revision ${revision}`,
      source: {
        builtIn: "SD built-in",
        jiuwenBuiltIn: "JiuwenSwarm built-in",
        jiuwenLocal: "Installed in JiuwenSwarm",
        managed: "managed",
      },
      instructionsLoading: "Reading the instructions…",
      /** 技能 › one package: the instructions' section heading. */
      detailView: {
        files: "Files",
      },
      /** The chevron on a managed Skill's row. */
      rowMenu: {
        actions: (name: string) => `Actions for "${name}"`,
        export: "Export",
        edit: "Edit",
        delete: "Delete",
        exported: (name: string) => `Exported "${name}".`,
        exportUnsupported: "The backend could not find this Skill package. Make sure it runs the current build with the Skill export route, then retry.",
        exportFailed: "This Skill could not be exported.",
        deleteTitle: (name: string) => `Delete ${name}`,
        deleteBody: (name: string) =>
          `"${name}" is removed from this computer, along with its files and version history. This cannot be undone.`,
        deleteBlocked: (name: string, count: number) =>
          count === 1
            ? `"${name}" is still selected by 1 project or session. Deselect it there before deleting it.`
            : `"${name}" is still selected by ${count} projects or sessions. Deselect it there before deleting it.`,
        deleted: (name: string) => `Deleted "${name}".`,
        deleteFailed: "The Skill could not be deleted.",
      },
      uploadView: {
        title: "Upload skills",
        description: "Add a SKILL.md or a package from this computer to ScienceDiscovery.",
        dropTitle: "Drag a file here, or click to choose",
        dropHint:
          "One SKILL.md, or a .zip / .skill package that contains one. A ZIP brings its scripts and references with it.",
        reading: "Reading…",
        remove: "Remove",
        fileSize: (kilobytes: number) => `${kilobytes} KB`,
        writeInstead: "Write from scratch instead",
      },
      importAction: "Import",
      /** The close control every 技能 dialog carries. */
      closeDialog: "Close",
      /** 技能 › 上传技能, as the handoff's dialog. */
      uploadDialog: {
        hint: "A folder or .zip must contain SKILL.md; a lone .md needs the name and description in YAML. One archive holds one skill package — import a whole repository with \"Import from GitHub\".",
        chooseFile: "Choose file",
        dropTitle: "Choose a SKILL.md file",
        dropHint: "Click, or drag a package or file here",
        reselect: "Choose again",
        cancel: "Cancel",
        confirm: "OK",
        /** What the server refused, written from the facts in its refusal. */
        refusals: {
          entries: (actual: number, cap: number) => `The archive has ${actual} entries; the import accepts at most ${cap}.`,
          files: (actual: number, cap: number) => `The package has ${actual} files; the import accepts at most ${cap}.`,
          archiveBytes: (actual: string, cap: string) => `The archive is ${actual}; the limit is ${cap}.`,
          extractedBytes: (actual: string, cap: string) => `The unpacked package is ${actual}; the limit is ${cap}.`,
          fileBytes: (path: string, cap: string) => `"${path}" is over the ${cap} per-file limit.`,
          missingRoot: "The archive has no SKILL.md at its root.",
          severalRoots: "The archive's top level is not one package directory.",
          outsideRoot: "The archive contains files outside the package root.",
          onePackage: "One archive imports one skill package. To import a whole repository, use \"Import from GitHub\" and pick the skills you want.",
        },
      },
      /** 技能 › 从 GitHub 导入, as the handoff's dialog. */
      gitDialog: {
        subtitle: "Import from a public GitHub repository",
        advanced: "Advanced options",
        progress: (done: number, total: number) => `Importing (${done}/${total})`,
        importing: "Importing",
        invalidUrl: "That is not a valid URL. Enter it again.",
      },
      importBusy: "Importing…",
      backgroundImportDone: (count: number) => `Imported ${count} skills.`,
      backgroundImportPartial: (imported: number, failed: number) => `Imported ${imported}; ${failed} failed.`,
      backgroundImportEnableFailed: (imported: number, failed: number) =>
        `Imported ${imported}; ${failed} could not be enabled.`,
      backgroundImportFailed: "The background import failed.",
      backgroundImportFailures: (names: string, count: number) =>
        count > 3 ? `Failed: ${names} and ${count - 3} more` : `Failed: ${names}`,
      importFailed: "The import failed.",
      importSucceeded: (name: string) => `Imported "${name}".`,
      /** The 技能 page's own notices (design 1-4). */
      toastUploadDone: (name: string) => `"${name}" uploaded.`,
      toastUploadNotEnabled: (name: string) => `"${name}" was imported but could not be enabled.`,
      toastGitDone: "GitHub import done.",
      toastGitFailed: "GitHub import failed.",
      toastProgress: (done: number, total: number) => `Importing (${done}/${total})`,
      toastRetry: "Retry",
      toastClose: "Dismiss notice",
      git: {
        title: "Import from GitHub",
        description:
          "Inspect a repository first, then pick the packages to install. An import is pinned to the commit you saw.",
        url: "Repository URL",
        urlPlaceholder: "https://github.com/org/repo.git",
        ref: "Ref",
        refPlaceholder: "Optional, for example main",
        subdirectory: "Subdirectory",
        subdirectoryPlaceholder: "Optional, for example skills/my-skill",
        inspect: "Inspect",
        inspecting: "Inspecting…",
        inspectHint: "Cloning the repository and reading every SKILL.md. Usually seconds; a slow connection takes longer.",
        cancelInspect: "Cancel",
        inspectNetwork: "Could not reach GitHub. Check the network, proxy or VPN and try again.",
        inspectTimeout: "Connecting to GitHub timed out. Check the network, proxy or VPN and try again.",
        checkoutFailed: "The repository could not be checked out. Check its URL, the network and the proxy settings, then retry.",
        inspectFailed: "The repository could not be inspected.",
        commit: (commit: string) => `commit ${commit.slice(0, 12)}`,
        new: "New",
        update: "Update",
        unchanged: "Unchanged",
        invalid: "Unavailable",
        selectHint: "Choose the packages to import. Unchanged and unavailable packages cannot be imported.",
        found: (count: number) => count === 1 ? "Found 1 package" : `Found ${count} packages`,
        selectAll: "Select all",
        importSelected: (count: number) => `Import ${count} selected`,
        /** One inspection reads one page; when the repository carries more,
         *  this reads the next page and keeps the rows and ticks already
         *  shown. */
        loadMore: "Load more",
        loadingMore: "Loading…",
        loaded: (loaded: number, total: number) => `Loaded ${loaded} of ${total}`,
        empty: "No Skill package was found in this repository.",
      },
      editor: {
        edit: "Edit",
        title: (name: string) => `Edit ${name}`,
        hint: "Change the fields and files; a save applies to new sessions.",
        files: "Files",
        save: "Save",
        saving: "Saving…",
        saved: "Saved.",
        loadFailed: "The skill could not be read.",
        binary: "This file is not UTF-8 text and cannot be edited here.",
        readOnly: "Built-in skills are read-only.",
        conflict: "This skill changed while you were editing. Reopen it and try again.",
        name: "Name",
        description: "Description",
        descriptionHint: "This is how the agent decides when to use the skill — be specific.",
        instructions: "Instructions",
        license: "License",
        compatibility: "Compatibility",
        cancel: "Cancel",
        content: "Content",
        contentHint: "Markdown shown to the agent when the skill is invoked.",
        write: "Write",
        upload: "Upload",
        uploadTitle: "Upload a SKILL.md or text file",
        uploadHint: "Its contents fill the editor; switch back to Write to tweak.",
        contentReadFailed: "The selected file could not be read.",
        pasteHint: "Paste a full SKILL.md — if it has a --- metadata block at the top, the fields above auto-fill.",
        advanced: "Advanced settings",
        references: "References",
        referencesHint: "Supporting files (scripts, templates, data) the skill can read at runtime.",
        referencesUsage: (count: number, total: number, size: string, limit: string) =>
          `References: ${count} / ${total}; package: ${size} / ${limit}`,
        referencesDrop: "Drop reference files or click to browse",
        referencesDropHint: (directory: string) => `Saved under ${directory} in the skill.`,
        referencesEditHint: "Click a file below to edit it in place.",
        editResource: (path: string) => `Edit ${path}`,
        referenceDirectory: "Target directory",
        referenceDirectoryPlaceholder: "For example references, assets or scripts",
        referenceDirectoryHint: "New files are saved here; leave empty for the skill root.",
        referenceDirectoryInvalid: "The directory cannot be empty-segmented or contain . or ..",
        editingResource: (path: string) => `Editing reference file: ${path}`,
        saveFile: "Save file",
        closeReferenceEditor: "Close reference editor",
        /** 2-3: the file editor. */
        exit: "Exit editing",
        unsaved: "Unsaved",
        unsavedTitle: "Unsaved changes",
        unsavedBody: "This file is not saved. Any changes made here will be lost after leaving. Leave anyway?",
        deleteTitle: "Delete this item?",
        deleteBody: "This cannot be undone. Delete this item?",
        newFolder: "New folder",
        newFile: "New file",
        newFileIn: (path: string) => `New file in "${path}"`,
        uploadFile: "Upload",
        filePathPlaceholder: "File name or path, for example references/new.md",
        folderPathPlaceholder: "Folder name, for example references",
        invalidPath: "A name cannot be empty, start with /, or contain . or .. segments.",
        editPath: (path: string) => `Rename ${path}`,
        rename: "Rename",
        deleteAction: "Delete",
        deletePath: (path: string) => `Delete ${path}`,
        saveFailed: "The file could not be saved.",
        uploadNotText: (name: string) => `"${name}" is not a text file, so it cannot be uploaded as a skill file.`, 
        referenceEditingHint: "Change it, then press Save file.",
        referenceNotText: (name: string) => `"${name}" is not UTF-8 text and cannot be imported as a reference file.`,
        addReferenceFailed: "The reference file could not be read.",
      },
    },
    network: {
      heading: "Network",
      sandbox: {
        heading: "Sandbox network",
        mode: "Sandbox network mode",
        modeNone: "No network",
        modeAllowlist: "Domain allowlist",
        modeOpen: "Open network",
        modeOpenWarning:
          "Open network lets any code in the sandbox reach any address, keeping only private-network filtering. Continue?",
        saved: "Sandbox network saved",
        /** The allowlist editor. The accepted format is shown by the
         *  placeholder rather than explained in a sentence. */
        domains: "Allowed domains",
        domainsPlaceholder: "example.org\n*.example.org:443",
        emptyDomains: "Add at least one allowed domain.",
        saveDomains: "Save",
        scope: "Applies only to run_shell and code inside the sandbox.",
        /** [mac-direct] Installation-level opt-in. With it on, local code
         *  execution leaves the sandbox: the full local execution stack is
         *  affected — the Agent's own ephemeral Shell/Python and evolution
         *  candidates run with your own file, network and environment access;
         *  persistent shell sessions and persistent kernels are offered only
         *  when a sandbox is available, so they are unavailable without one;
         *  evolution runs still ask to confirm each time. macOS shell only.
         *  Copy red line: state the full blast radius — never narrowed to
         *  "candidates only" (review 2026-11-23).
         *  [hint-split] Layered presentation (2026-11-24 user feedback): the
         *  hint keeps one lead sentence and the full blast radius moves to
         *  hintDetails; every point is preserved, the red line is unchanged —
         *  the copy tests assert over hint + hintDetails combined.
         *  [F29] The restart clause stays in the lead hint, not the details:
         *  flipping the switch gives no immediate feedback (the status row
         *  states the spawn-time mode until the next spawn), so the clause
         *  is the only thing that explains the window right after the flip —
         *  the one moment it matters, it must be always visible. */
        directExecution: {
          heading: "Sandbox",
          field: "Run local code without a sandbox",
          hint: "With this on, local code execution leaves the sandbox. Applies after a restart.",
          hintDetails: [
            "Code runs with your own file, network and environment access (including the Agent's own ephemeral Shell/Python and evolution candidates)",
            "Persistent shell sessions and persistent kernels need a sandbox, so they are unavailable",
            "R execution needs a sandbox and is unavailable while this is on (the direct channel supports Python only)",
            "Evolution runs still ask to confirm each time",
            ],
          showDetails: "Show full impact",
          hideDetails: "Hide",
        },
        /** [U5c] The sandbox status row of 设置 › 连接 › 沙箱网络 — the one place
         *  sandbox health is surfaced (owner decision 2026-11-23: the boot
         *  neither blocks nor mentions the sandbox; monitoring lives in
         *  settings alone). */
        status: {
          field: "Sandbox status",
          ok: "✓ macOS sandbox (Seatbelt) running — local code executes sandboxed",
          /** [F26] The adopted-stack window: this session attached to an
           *  already-running backend, so the mode the ok/optedOut sentences
           *  would assert is an inference from this shell's inputs, not the
           *  survivor's env — the row says so instead of guessing.
           *  [F26-followup] No restart advice: quitting stops only a stack
           *  this shell spawned, so a restart usually re-adopts the same
           *  surviving stack. The honest way to verify is to stop that
           *  backend and let the app spawn its own. */
          attached: "This session attached to an already-running backend stack; its sandbox mode is not verified by this session (not knowable from outside). To have the mode confirmed, stop that backend process first — interrupt it in the terminal that started it, or quit it from Activity Monitor — then let the app spawn its own stack.",
          /** [F16] The honest row: when the switch is ON, the session runs
           *  direct no matter what the probe said — the row must say so. The
           *  way back is the switch, not "restore and restart". */
          optedOut: "Local code currently executes directly, unsandboxed (the switch below is ON). Turn it off and restart the app to return to sandboxed mode.",
          /** [F22] The mid-session toggle-off window: the stack still runs
           *  direct but the switch is already OFF — tell the user the restart
           *  is what applies their change, not "turn off the switch" (which
           *  they just did). [F24] No probe clause here: this sentence only
           *  renders when the probe verdict is not "failed" (the failed branch
           *  wins the row), so a probe cause can never reach it. */
          optedOutSwitchOff: "Local code currently executes directly, unsandboxed (this session started with the switch on). Restart the app to return to sandboxed mode.",
          /** The probe failed this session — the cause follows from the
           *  structured detail (failCause sentence), the raw reason rides the
           *  dot's tooltip with the diagnostics. R execution needs a sandbox
           *  and is refused in this session too (F17). */
          failed: "The sandbox is unavailable: this session runs local code unsandboxed; R execution and persistent shell sessions/kernels are unavailable (see the switch below for what that means); evolution runs still ask to confirm each time.",
          /** Composed from detail.failCode — en sentences for the three
           *  structured causes (spawn-error / signal / exit-code). */
          failCause: {
            "spawn-error": "Cause: the sandbox-exec command was not found.",
            signal: "Cause: the probe process was killed by a signal before it could confirm Seatbelt.",
            "exit-code": "Cause: Seatbelt may be disabled under MDM control or nested virtualization.",
            },
        },
      },
    },
    runtime: {
      heading: "Remote",
      allowlist: {
        empty: "No remote machines yet. Register one above and wait for it to connect.",
        heading: "Allowed machines",
      },
      runner: {
        add: "Add a remote Runner",
        alias: "SSH alias or IP/hostname",
        aliasPlaceholder: "e.g. gpu-01 or 10.0.0.9",
        cancel: "Cancel",
        connect: "Connect",
        connecting: "Connecting…",
        connectLog: {
          empty: "No output from this connection yet.",
          heading: "Connection log",
          live: "Live",
        },
        cpuCores: (count: number) => `${count} ${count === 1 ? "core" : "cores"}`,
        credentials: {
          cancel: "Cancel",
          forget: "Forget the saved password, private key and passphrase",
          heading: "Login credentials",
          keyKeep: "Leave blank to keep the stored private key",
          note: "Credentials are write-only: the API never returns them, so leaving a field blank keeps the stored one.",
          passphraseKeep: "Leave blank to keep the stored passphrase",
          passphrasePlaceholder: "Leave blank if the key has no passphrase",
          secretKeep: "Leave blank to keep the stored password",
          save: "Save and test",
        },
        delete: "Delete",
        deleteBody:
          "The Runners connected on this machine will disconnect, and it will be removed from this project's allowed list. Results already produced are unaffected.",
        deleteConfirm: (name: string) => `Delete the machine "${name}"?`,
        destinationUnknown: "Address unknown",
        disconnect: "Disconnect",
        empty: "No Runners registered.",
        endpoint: "Address",
        endpointPlaceholder: "10.0.0.9:4311",
        keyFile: "Private key file",
        keyPair: {
          copied: "Copied",
          copy: "Copy public key",
          generate: "Generate a key pair",
          note: "The private key stays in the service's data directory and never passes through the browser. Add this public key line to the machine's ~/.ssh/authorized_keys, then test the connection again.",
          title: "Public key",
        },
        keyPlaceholder: "A path this service can read, e.g. ~/.ssh/id_ed25519",
        keyStored: "Private key stored",
        resources: {
          aria: "Runner resources",
          cores: "CPU cores",
          diskUnknown: "Workspace disk: unknown · measured after the Runner connects",
          diskUsed: "Disk used",
          gpu: (gpu: string) => `GPU: ${gpu}`,
          hours: "hours",
          load1m: "Load · 1 min",
          lowDisk: (available: string, required: string) =>
            `Not enough workspace disk space: only ${available} left, while the Runner's required components plus two base conda environments need about ${required}. Environment installation and file writes may fail.`,
          memoryUsed: "Memory used",
          meterUnknown: (label: string) => `${label}: unknown`,
          noMetrics: "Workspace disk: metrics unavailable",
          updated: "Updated",
          uptime: "Host uptime",
        },
        npu: {
          aiCore: (percent: number) => `AI Core ${percent}%`,
          aiCoreLabel: "AI Core utilisation",
          card: (chip: string, index: number) => `NPU ${index} · ${chip}`,
          cardChip: (card: number, die: number, chip: string, index: number) =>
            `NPU ${card} · die ${die} · ${chip} (device ${index})`,
          count: (total: number, usable: number) =>
            `${total} on this host · ${usable} usable in the sandbox`,
          discard: "Discard changes",
          memoryCaption: "Memory",
          memoryLabel: "Memory usage",
          none: "This host reports no Ascend cards.",
          noneUsable:
            "No card on this host can currently be opened in a sandbox, so none can be selected.",
          power: (watts: number) => `${watts} W`,
          powerLabel: "Power",
          renumbered:
            "Selected cards are renumbered from 0 inside the sandbox, so code can use device 0 directly.",
          save: "Save selection",
          saving: "Saving…",
          temperature: (celsius: number) => `${celsius} °C`,
          temperatureLabel: "Temperature",
          title: "NPU cards",
          unusable: "This card cannot be opened in a sandbox.",
          unusableSelected:
            "Runs that use it will keep failing until it is released; clear the checkbox to run without this card.",
          unsaved: "Selection not saved",
        },
        kind: {
          direct: "Self-hosted",
          local: "Local",
          ssh: "SSH",
        },
        kindLabel: "Connection type",
        local: "Local",
        localHelp: "Runs on this machine; no registration needed.",
        machineDetails: "Machine details",
        noDetail: "This Runner has not reported its status yet.",
        passphrase: "Key passphrase",
        secret: "Login password",
        secretStored: "Password stored",
        port: "SSH port",
        portLabel: "Port",
        portPlaceholder: "Blank for 22",
        reachability: {
          checking: "Checking",
          checkingHelp: "Asking whether this machine is online.",
          offline: "Machine offline",
          offlineHelp: "The Runner is not connected and the machine itself does not respond.",
          online: "Machine online",
          onlineHelp: "The Runner is not connected yet, but the machine responds.",
          unknown: "Machine status unknown",
          unknownHelp:
            "No credentials are stored for this machine, so it cannot be asked whether it is online.",
        },
        register: "Register and test",
        registerDirect: "Register and connect",
        sshConfig: {
          import: "Import from ssh_config",
          importFailed: (alias: string) => `Could not import ${alias} from ssh_config`,
          listFailed: "Could not read ssh_config",
          loading: "Reading ssh_config…",
          none: "This ssh_config has no Host entries to import.",
          note: (alias: string, target: string, keyNote: string) =>
            `Imported ${alias}${target}${keyNote} — every field is still editable.`,
          noteKeyUnreadable:
            " — this installation cannot read that key file; choose another key file or generate a new key",
          noteTarget: (host: string) => ` (connecting to ${host})`,
          portPrefix: (port: number) => `port ${port}`,
        },
        keyBrowser: {
          aria: "Files on the machine running the app",
          browse: "Browse",
          browseFailed: "Cannot browse the app's machine",
          cancelSelection: "Clear selection",
          empty: "This directory has no files.",
          folder: "Folder",
          go: "Go",
          help: "These files belong to the machine running ScienceDiscovery — not this browser, and not the remote SSH target. Only the selected path is filled in; file contents are never shown.",
          home: "Home",
          loading: "Loading files…",
          nextPage: "Next page",
          pathLabel: "Directory or file path",
          previousPage: "Previous page",
          selectFile: "Select file",
          title: "Choose a key on the app's machine",
          unavailable: "unavailable",
          up: "Up one level",
        },
        runnerCommand: "Runner executable",
        state: {
          connectFailed: "Connection failed",
          connecting: "Connecting",
          disconnected: "Disconnected",
          error: "Error",
          ready: "Ready",
          starting: "Starting",
          stopped: "Stopped",
          unknown: "Unknown",
        },
        token: "Access token",
        tokenPlaceholder: "The remote runner's SCIENCE_AGENT_RUNNER_TOKEN",
        trust: {
          cancel: "Cancel",
          changed: (target: string) => `The host key of ${target} differs from last time.`,
          changedBody:
            "Either the machine changed its key, or something in between is answering for it. Continue only after checking that the new fingerprint really belongs to this machine.",
          confirm: "Trust and continue",
          unknown: (target: string) => `${target}'s host key is not known yet.`,
          unknownBody:
            "This is the first connection to this machine. It is the machine itself only if the fingerprint matches the one its administrator gave you.",
        },
        untrusted: "Host key unverified",
        unusable: "Currently unavailable",
        username: "Login user",
        usernamePlaceholder: "e.g. researcher",
      },
    },

    system: {
      title: "Settings",
      eyebrow: "Settings",
      navLabel: "Settings directory",
      save: "Save",
      saving: "Saving…",
      categories: {
        system: "System",
        intelligence: "Intelligence",
        connection: "Connection",
        workspace: "Workspace",
      },
      groups: {
        general: { label: "General", description: "Interface language and preferences for this device" },
        memory: { label: "Scientific memory", description: "The memory service behind evidence and artifacts" },
        models: { label: "Models", description: "Profiles and provider credentials" },
        usage: { label: "Model usage", description: "Model tokens recorded by the connected service" },
        skills: { label: "Skills", description: "Create, import, edit, enable, or disable skills" },
        mcp: { label: "MCP servers", description: "Manage built-in and custom MCP services and choose the tool sources sessions use by default" },
        specialists: { label: "Specialists", description: "Reusable instructions and tool bundles" },
        "sandbox-network": { label: "Sandbox network", description: "Network access for run_shell" },
        remote: { label: "Runtime environments", description: "Runner connections, resources, scientific environments and global package sources" },
        quotas: { label: "Run quotas", description: "Concurrency, output, workspace and upload limits" },
        web: { label: "Web search", description: "JiuwenSwarm search services and webpage reading" },
        proxies: { label: "Network proxies", description: "Default proxy, servers and module policies" },
        timeouts: { label: "Timeouts", description: "Wall-clock limits and unlimited mode" },
        "session-management": { label: "Session management", description: "Archived sessions, to restore or delete for good" },
        "export-history": { label: "Export history", description: "Study packages saved on this machine" },
        "idea-tree": { label: "Idea Tree", description: "Research scope and stage prompt overrides" },
      },
      global: {
        modelHeading: "Default model",
        model: "Default model",
        modelHint: "Used by a new session when it names no model.",
        modelUnset: "Not set",
        approval: "Default approval mode",
        approvalHint: "The permission mode new sessions inherit.",
        connectorsHeading: "Connectors",
        connectorsEmpty: "No connectors are available on this machine yet.",
      },
      mcp: {
        allMcp: "All MCP",
        myMcp: "My MCP",
        officialMcp: "Official MCP",
        searchMcp: "Search MCP",
        enableAll: "Enable all",
        disableAll: "Disable all",
        bulkHint: "Bulk actions affect only the custom servers shown. Built-in switches select sources by default.",
        bulkFailed: (names: string) => `Could not update: ${names}. Retry to update the remaining servers.`,
        tryIt: "Try it",
        tryUnavailable: "Enable the service before trying it. Built-in sources must be available.",
        noMatches: "No matching MCP servers",
        manualEntry: "Manual entry",
        importJsonEntry: "Import JSON",
        jsonSource: "JSON source",
        importFillHint: "Paste an mcpServers JSON object or upload a file. Review and edit the configuration below, then confirm to add it.",
        importEmptyHint: "Paste or upload JSON to fill the configuration fields.",
        chooseConfiguration: "Server configuration",
        duplicateName: "Server names must be unique.",
        timeoutInvalid: "Timeout must be an integer between 1 and 600 seconds.",
        commandRequired: "A command is required for STDIO.",
        urlInvalid: "Use an HTTP(S) URL without credentials or a fragment.",
        confirmAdd: (count: number) => count > 1 ? `Add ${count} servers` : "Confirm add",
        importFilled: (count: number) => `${count} configuration(s) filled. Review and edit before confirming.`,
        importProgress: (added: number, total: number) => `${added} of ${total} added. Only remaining configurations will be retried.`,
        addedCount: (count: number) => `${count} MCP servers added`,
        savedCheckFailed: (reason: string) => `Configuration saved. Connection check: ${reason}`,
        importFieldInvalid: (name: string, field: string) => `Invalid ${field} in “${name}”. Correct the JSON and try again.`,
        configured: "Configured servers",
        details: "Server details",
        custom: "External",
        noDescription: "No description",
        builtinReadOnly: "Built-in sources are managed by the application and are read-only.",
        checkedAt: "Last checked",
        neverChecked: "No check recorded",
        checkHint: "Connection status is the last discovery or test result, not a continuous heartbeat. Service enablement and session default selection are independent.",
        storedValue: "Stored securely",
        publisher: "Publisher / version",
        serviceEnabled: "Enabled",
        selected: "Selected",
        notSelected: "Not selected",
        authorized: "Authorized",
        authorizing: "Waiting for authorization",
        deleted: "MCP server deleted",
        retry: "Retry",
        more: (name: string) => `More actions for ${name}`,
        openDetails: (name: string) => `View ${name} details`,
        heading: "MCP servers",
        help: "Use by default selects sources for sessions that inherit global settings; explicit project or session selections take precedence. Specialists may add other sources. Actual tool calls still depend on service readiness and permissions. Enable service in a custom server’s edit form controls its connection separately. Changes do not reconfigure a running task.",
        builtin: "Built-in",
        useByDefault: "Use by default",
        enableService: "Enable service",
        selectAll: "Select all",
        clearSelection: "Clear selection",
        empty: "No built-in or custom MCP sources are available yet.",
        editTitle: "Edit server",
        name: "Name",
        description: "Description",
        transport: "Transport",
        command: "Command",
        args: "Arguments",
        argsHint: "One argument per line.",
        cwd: "Working directory",
        url: "URL",
        timeout: "Timeout (seconds)",
        optional: "Optional",
        env: "Environment variables",
        headers: "Headers",
        key: "Key",
        value: "Value",
        secretSaved: "Stored; leave blank to keep",
        addEntry: "Add entry",
        removeEntry: "Remove this entry",
        secretKeyEmpty: "A key cannot be empty.",
        secretKeyDuplicate: "Keys must be unique.",
        secretRenameRequired: "A renamed key needs its value typed again.",
        authMode: "Authentication",
        authHeaders: "Headers",
        authOauth: "OAuth",
        clientId: "Client ID",
        clientSecret: "Client Secret",
        scope: "Scope",
        metadataUrl: "Client metadata URL",
        callback: "Callback URL",
        toolCount: (count: number) => `${count} tools`,
        statusReady: "Connected",
        statusError: "Connection failed",
        statusDisabled: "Disabled",
        statusUntested: "Not tested",
        statusDegraded: "Degraded",
        statusMisconfigured: "Misconfigured",
        statusUnavailable: "Unavailable",
        test: "Test",
        testPassed: "Connection test passed",
        tested: (status: string) => `Test result: ${status}`,
        saved: "MCP server saved",
        deleteTitle: (name: string) => `Delete the server “${name}”?`,
        deleteBody: (name: string) =>
          `Tools that depend on “${name}” stop working. Results already produced are unaffected.`,
        addServer: "Add MCP server",
        createTitle: "New MCP server",
        importServers: "Import",
        importPaste: "Paste JSON",
        importFile: "Upload JSON file",
        importFileLoaded: (name: string) => `File loaded: ${name}`,
        importFileTooLarge: "The JSON file must not exceed 1.5 MB.",
        importFileReadFailed: "Could not read the file. Select the JSON file again.",
        importTooMany: "Import at most 50 servers at a time.",
        importTitle: "Import MCP servers",
        importHint: "Paste a JSON spec with an mcpServers object; each server is written on its own and reports its own result.",
        importJson: "JSON",
        importPreview: "Preview",
        importRun: "Import servers",
        importResults: "Import results",
        importInvalidJson: "That is not valid JSON.",
        importNoServers: "The JSON needs a non-empty mcpServers object.",
        importBadEntry: (name: string) => `“${name}” is not a server configuration object.`,
        importAdded: "Added",
        importFailed: (reason: string) => `Failed: ${reason}`,
        tools: "Tools",
        toolsNone: "The server returned no tools.",
        testedResult: "Test result",
        done: "Done",
        unauthorized: "Not authorized",
        authorizationExpired: "Authorization expired",
        authorize: "Authorize",
        cancelAuthorization: "Cancel authorization",
        clearAuthorization: "Clear authorization",
        nameRequired: "A server name is required.",
        openAuthorization: "Open the authorization page",
        actions: (name: string) => `Actions for ${name}`,
        importChoice: "Import JSON",
      },
      web: {
        searchHeading: "Search",
        free: "Free search engines",
        freeHint: "No key needed; used as a fallback.",
        paid: "Paid providers",
        paidHint: "A provider with a key and enabled is tried first.",
        deepseek: "DeepSeek search",
        fetchHeading: "Fetch and cache",
        fetchProvider: "Fetch provider",
        searchCache: "Search cache (seconds)",
        fetchCache: "Fetch cache (seconds)",
        proxy: "Proxy policy",
        proxyHint: "The proxy Web search and fetch use.",
        keysHeading: "Provider keys",
        keysHint: "Keys are write-only: leave one empty to keep the stored key.",
        keySet: "Set",
        keyUnset: "Not set",
        keyPlaceholder: "Paste a new API key",
      },
      memory: {
        heading: "Memory graph",
        help: "Scientific memory keeps the evidence and artifacts a report cites as a graph; the citation buttons in a report read from it. Both reads and writes go through the memory service on this machine.",
        enabled: "Enable scientific memory",
        enabledHint: "When off, nothing is written to or read from memory. Existing data stays.",
      },
      ideaTree: {
        scopeHeading: "Research scope",
        template: "Template",
        templateHint: "Chooses how hypotheses and designs are asked for.",
        templateGeneral: "General scientific hypothesis",
        templateWater: "Water-treatment materials",
        intensity: "Exploration intensity",
        intensityHint: "Higher explores more directions, at more time and tokens.",
        quick: "Quick",
        standard: "Standard",
        deep: "Deep",
        direction: "Score direction",
        directionHint: "Maximize means higher is better; minimize the opposite.",
        maximize: "Maximize",
        minimize: "Minimize",
        maxDepth: "Maximum depth",
        maxDepthHint: "How many levels the tree may grow.",
        maxNodes: "Maximum nodes",
        maxNodesHint: "The whole tree's node limit.",
        tokens: "Token limit",
        tokensHint: "Total tokens one research may use; empty means no extra cap.",
        noCap: "No extra cap",
        promptsHeading: "Stage prompt overrides",
        designPrompt: "Design stage",
        aggregatorPrompt: "Aggregate stage",
        propagatePrompt: "Insight propagation",
        promptHint: "Leave empty to use the template's own prompt.",
        promptPlaceholder: "Empty uses the template default",
        save: "Save",
        saving: "Saving…",
        saved: "Saved; it applies to later researches.",
        failed: "Saving failed.",
        unavailable: "The Idea Tree service is not ready: start the Evolve service, then come back and retry.",
      },
      specialists: {
        heading: "Specialists",
        add: "Add specialist",
        help: "A specialist is a reusable bundle of instructions and tools that work can be dispatched to.",
        /** The line under the built-in Review Specialist. It says who uses it,
         *  which is the only thing there is to say about it: it cannot be
         *  turned off, so there is no state to describe. */
        reviewerUse: "Used by Auto-review",
        builtIn: "Built-in",
        enabled: "Enabled",
        disabled: "Disabled",
        editTitle: "Edit specialist",
        name: "Name",
        namePlaceholder: "For example, RNA-seq reviewer",
        description: "Description",
        descriptionPlaceholder: "A short description shown in lists",
        instructions: "Instructions",
        instructionsHint: "Define this specialist's role and workflow. Platform tool and permission rules still apply.",
        instructionsPlaceholder: "For example, flag missing values and explain each anomaly.",
        runtime: "Runtime",
        runtimeHint: "An external runtime uses the matching command-line agent.",
        runtimeNative: "Native",
        model: "Model",
        modelHint: "Leave empty to use the runtime's default model.",
        connectors: "Connectors",
        skills: "Skills",
        none: "Nothing to choose from.",
        capabilities: "Capabilities",
        capabilitiesHint: "The skills and connectors this specialist may use. Anything not chosen here stays invisible and uncallable in its sessions, even when enabled globally.",
        fullAccess: "Full access",
        defaultTag: "Default",
        fullAccessHint: "Use all of the main agent's skills and connectors, including ones added later. No per-item setup.",
        orSpecific: "Or choose specific capabilities",
        addSkill: "Add skill",
        addConnector: "Add connector",
        noSkills: "No skills added yet.",
        unavailableSkill: (id: string) => `Unavailable skill: ${id}`,
        unavailableSkillsHint: "Some selected skills are no longer in the catalog. Remove them explicitly before saving; capabilities are never broadened automatically.",
        noConnectors: "No connectors added yet.",
        skillsNote: "The skill list starts empty and must be filled in by hand. Skills not listed here are invisible to this specialist, and calls to them are refused.",
        connectorsNote: "The connector list starts empty and must be filled in by hand. Connectors not listed here are invisible to this specialist, and calls to them are refused.",
        pickerTitle: "Add skills and connectors",
        pickerEmptySkills: "No skills to add.",
        pickerEmptyConnectors: "No connectors to add.",
        remove: "Remove",
        addSelected: "Add",
        deleteTitle: (name: string) => `Delete the specialist “${name}”?`,
        deleteBody: (name: string) =>
          `“${name}” can no longer be dispatched to. Results already produced are unaffected.`,
      },
      proxies: {
        defaultHeading: "Global default",
        default: "Default policy",
        defaultHint: "Used by modules without a separate proxy policy.",
        serversHeading: "Proxy servers",
        empty: "No proxy servers registered yet.",
        add: "Add proxy",
        name: "Name",
        kind: "Kind",
        kindCustom: "Custom URL",
        kindEnvironment: "Environment variables",
        kindSystem: "System settings",
        url: "Proxy URL",
        urlHint: "For example http://proxy.example.test:8080",
        urlStored: "Saved; leave blank to keep",
        noUrl: "No URL",
        webHeading: "Web policy",
        web: "Web proxy",
        webHint: "The proxy search and fetch use.",
        mcpHeading: "MCP policy",
        mcpHint: "Each MCP server can pick its own proxy.",
        mcpEmpty: "No MCP servers yet.",
        inherit: "Inherit global default",
        none: "Do not use a proxy",
        environmentConfigured: "Configured",
        environmentUnconfigured: "Not configured",
        environmentInvalid: "Invalid",
        environmentSource: (name: string) => `Effective source: ${name}`,
        systemNote: "Environment entries read the process's HTTP(S), ALL_PROXY, and NO_PROXY values; system entries resolve the desktop environment's proxy settings.",
        deleteTitle: (name: string) => `Delete the proxy “${name}”?`,
        deleteBody: (name: string) =>
          `Modules using “${name}” fall back to the global default. Connections already open are unaffected.`,
      },
      usage: {
        range: "Usage period", today: "Today", week: "Last 7 days", month: "Last 30 days", all: "All time",
        refresh: "Refresh", refreshing: "Refreshing…", total: "Total tokens", input: "Input tokens", output: "Output tokens",
        totalColumn: "Total", inputColumn: "Input", outputColumn: "Output", model: "Model", byModel: "Usage by model (tokens)",
        unreported: "Not reported", incomplete: "Only reported usage is included. Actual usage may be higher.",
        empty: "No model usage recorded for this period.", updated: "Updated",
        skeleton: "Loading model usage…",
      },
      migrated: {
        common: {
          working: "Working…",
          saved: "Saved",
          save: "Save",
          cancel: "Cancel",
          edit: "Edit",
          remove: "Delete",
          refresh: "Refresh",
          invalidNumber: "Enter a valid number.",
          advanced: "Advanced settings",
        },
        environments: {
          heading: "Scientific environments",
          machinesHeading: "Execution machines",
          connectionHeading: "Connection and resources",
          overviewHint: "Select a Runner to manage its connection, machine resources and scientific environments.",
          back: "Back to runtime environments",
          skeleton: "Loading runtime environments…",
          runner: "Runner",
          local: "Built-in Runner",
          scope: "These environments are installed on this machine for tasks to execute code.",
          localHint: "The built-in Runner is on the backend host.",
          unavailable: "Connect this Runner above before managing its scientific environments.",
          setup: "Initialization status",
          setupHint: "Whether the environment installer and base environment are ready.",
          initialize: "Initialize environments",
          retry: "Retry initialization",
          states: {
            disabled: "Unavailable",
            failed: "Initialization failed",
            installing: "Initializing",
            "not-configured": "Not initialized",
            ready: "Ready",
          },
          environmentStates: { ready: "Ready", updating: "Updating", failed: "Update failed" },
          catalog: "Environments",
          catalogHint: "Base environments are read-only. Create a custom environment to install additional packages.",
          empty: "No environments are available on this machine yet.",
          base: "Base environment · read-only",
          managed: "Custom environment",
          create: "Create environment",
          creating: "Creating…",
          created: "Created",
          name: "Name",
          language: "Initial language",
          packages: "Packages to install",
          packagesHint: "Enter package names with optional versions, separated by spaces, commas, or newlines.",
          installedPackages: "Installed packages",
          installedPackagesHint: "Packages recorded in the current environment revision, for reference.",
          manager: "Package manager",
          install: "Install",
          revision: "Version",
          noSnapshot: "No package snapshot available.",
          sources: "Global package sources",
          sourcesHint: "Package download sources shared by all Runners for later initialization and installation. Installed packages stay unchanged.",
          conda: "Conda source",
          pip: "Pip source",
          deleteTitle: "Delete environment?",
          deleteBody: "This deletes this custom environment on the selected machine.",
          details: "Environment details",
        },
        web: {
          help: "Configure search and webpage reading for JiuwenSwarm.",
          unsupported: "This page currently supports only the JiuwenSwarm backend.",
          free: "Free search",
          freeHint: "No key required. Keep an engine enabled to search without paid credentials.",
          paid: "Paid search services",
          paidHint: "Saved keys make services available to JiuwenSwarm paid search. The backend determines attempt order; calls may incur charges.",
          fetchHeading: "Webpage fetching",
          fetchProvider: "Fetch with",
          fetchDefault: "JiuwenSwarm default",
          fetchCost: "Fetching with DeepSeek incurs charges.",
          keyRequired: "Configure the DeepSeek API key above before using it.",
          deepseekKeyHint: "Saving enables search and shares the key with webpage fetching. Leave blank to keep the saved key.",
          searchInactive: "Search inactive",
          reconfigureToEnable: "Save the key again to enable search.",
          deepseekRemoveBody: "Removing the key disables DeepSeek search and restores the JiuwenSwarm default fetcher.",
          key: "API Key",
          configure: "Configure key",
          configured: "Configured",
          missing: "Not configured",
          keyHint: "Leave blank to keep the saved key. Removal requires separate confirmation.",
          removeTitle: "Remove key?",
          removeBody: "This service will no longer be able to use the removed credential.",
          saved: "Settings saved",
          activation: "Saving attempts to synchronize JiuwenSwarm. Saved status does not verify connectivity or synchronization.",
        },
        proxy: {
          noProxy: "Bypass proxy",
          noProxyHint: "Separate hosts or domains with commas, e.g. localhost,.example.com. Leave blank to use the backend's NO_PROXY.",
          scope: "Proxy settings apply on the backend host.",
          swarmNote: "JiuwenSwarm search and webpage reading use separate network settings and are unaffected here.",
          test: "Test connection",
          testOk: "Connected",
          testFailed: "Connection failed",
          systemTest: "Connection testing is unavailable for system proxies.",
          deleteBody: "A proxy in use cannot be deleted. Change the settings that reference it first.",
          modules: "Module proxies",
          mcp: "MCP services",
          web: "Built-in Web search and reading",
          diagnostics: "Environment variable status",
          nameRequired: "Enter a proxy name.",
          urlRequired: "Enter a complete proxy URL.",
        }
      },
      connection: {
        heading: "Connection",
        help: "Connect to the ScienceDiscovery service on this machine with its local access token. External model API keys belong in Model registry.",
        token: "Local service access token",
        hint: "The token is stored in this browser, not in the service configuration.",
        storage: "Replacing the token reconnects the client with it immediately.",
        missing: "The token cannot be empty.",
      },
      timeouts: {
        heading: "Timeouts",
        help: "An operation is cancelled when it reaches its limit. Set an item to unlimited to remove its timeout.",
        gatewayIdle: "Gateway idle timeout",
        gatewayIdleHint: "How long to wait when a connection sends no new data.",
        gatewayTurn: "Turn timeout",
        gatewayTurnHint: "The longest a single conversational turn may take. When both are set, the turn limit is at least the idle limit; setting either one to unlimited removes the rule.",
        kernelIdle: "Kernel idle timeout",
        kernelIdleHint: "How long a persistent kernel may sit idle before it is reclaimed.",
        permissionWait: "Approval wait timeout",
        permissionWaitHint: "The longest wait for a user's approval.",
        runnerExec: "Execution timeout",
        runnerExecHint: "The longest one code execution in the sandbox may take.",
        seconds: "seconds",
        unlimited: "Unlimited",
        saved: "Saved",
        orderError: "The turn timeout cannot be shorter than the gateway idle timeout. Raise the turn timeout, lower the idle timeout, or set one of them to unlimited.",
      },
      quotas: {
        heading: "Quotas",
        help: "Unlimited removes a byte limit. Output limits truncate retained output; workspace and upload limits restrict writes. Concurrency applies to later runs.",
        subagents: "Concurrent subagents",
        subagentsHint: "How many subagents one run may execute at once (1–10).",
        workspace: "Workspace quota",
        workspaceHint: "The total size of one session's workspace.",
        output: "Output retain limit",
        outputHint: "The stdout and stderr retained for one execution.",
        uploadFile: "Upload file limit",
        uploadFileHint: "The size of each file in an upload.",
        uploadRequest: "Upload request limit",
        uploadRequestHint: "The total size of one upload request.",
        gb: "GB",
      },
      runtime: {
        heading: "Runner",
        captured: "Read at",
        refresh: "Refresh",
        runnerVersion: "Runner version",
        sessionsHeading: "Running sessions",
        sessionsEmpty: "No sessions are running.",
        executionsHeading: "Executions",
        executionsEmpty: "No code is executing.",
        kernelsHeading: "Persistent kernels",
        kernelsEmpty: "No kernels are running.",
        teardown: "End kernel",
      },
      runner: {
        heading: "Runner",
        local: "Local Runner",
        localHelp: "Runs on this machine; nothing to register.",
        remoteHelp: "This machine's connection state, resources, and allowlist.",
        add: "Add remote Runner",
        addHelp: "Register a remote machine and execute on it once it connects.",
        state: "State",
        location: "Location",
        workspaceRoot: "Workspace root",
        missing: "This Runner was not found.",
        versionMismatch: (local?: string, remote?: string) =>
          `Runner versions differ: local ${local ?? "unknown"}, remote ${remote ?? "unknown"}.`,
      },
    },
  },


  workspace: {
    newTab: "New tab",
    artifacts: "Artifacts",
    collapsible: "Workspace",
    groups: {
      task: "Task",
      artifacts: "Artifacts",
      files: "Workspace",
    },
    empty: "No artifacts yet.",
    filesEmpty: "No files in the workspace yet.",
    unopenedArtifacts: "No artifact is open yet.",
    unopenedFiles: "No file is open yet.",
    /** The heading over the open Session's group of artifacts. */
    currentSession: "Current session",
    /** The heading of a group whose Session the app has no title for. */
    untitledSession: "Untitled session",
    filesTitle: (count: number) => `Workspace · ${count} ${count === 1 ? "file" : "files"}`,
    filesCount: (count: number) => `${count} ${count === 1 ? "file" : "files"}`,
    sessionRoot: "This session",
    root: "Workspace root",
    justNow: "just now",
    minutesAgo: (minutes: number) => `${minutes} min ago`,
    hoursAgo: (hours: number) => `${hours} h ago`,
    yesterday: "yesterday",
    daysAgo: (days: number) => `${days} d ago`,
    weeksAgo: (weeks: number) => `${weeks} w ago`,
    open: "Open",
    unsupported: "No preview for this type yet.",
    closeTab: "Close tab",
    resize: "Resize panel",
    resizeList: "Resize the list",
    expand: "Expand",
    collapsePanel: "Collapse panel",
    backToGroups: "Back to artifacts and files",
    allArtifacts: "All artifacts",
    download: "Download",
    version: "Version",
    searchArtifacts: "Search artifacts",
    searchFiles: "Search files",
    searchEmpty: "Nothing matches.",
    /** The caption under a table that holds all of the document's rows. */
    tableRows: (count: number) => `${count} ${count === 1 ? "row" : "rows"}`,
    /** The same caption when the panel holds only the head of a larger table. */
    tableRowsShown: (shown: number, total: number) => `Showing the first ${shown} of ${total} rows`,
    /** A column whose first cell named nothing, named by where it sits. */
    tableColumn: (index: number) => `Column ${index}`,
    tableEmpty: "This table has no data.",
    workbookUnreadable: "This workbook could not be read. Download it to open it.",
    worksheets: "worksheets",
    imageAlt: (name: string) => `Preview of ${name}`,
    imageActual: "Show at actual size",
    imageFit: "Fit to the panel",
    pdfFallback: "If the page does not appear, download it:",
    tooLarge: "This file is too large to preview here. Download it to open it.",
    unrenderable: "This build has no preview for this file's format. Download it to open it.",
    sourceTruncated: "This file is long; only the beginning is shown.",
  },

  molstar: {
    loading: "Loading structure…",
    initFailed: "The structure view could not start.",
    viewerAria: (name: string) => `3D structure of ${name}`,
    atoms: (count: number) => `${count} atoms`,
    expand: "Expand to full screen",
    close: "Exit full screen",
  },

  /** Program evolution: a search that improves itself against a scorecard.
   *
   *  The run card and the full panel share this block; the wording is written
   *  for the panel and shortened for the card, so a run is called the same
   *  thing in both places. */
  evolve: {
    title: "Program evolution",
    open: "Program evolution",
    moreRuns: (count: number) => `${count} more`,
    fewerRuns: "Show fewer",
    /* The whole card is a button, and what it opens is the task panel in the
       right column rather than an inline expand; the card says so instead of
       drawing a chevron that promises the other thing. */
    openPanel: "Open task panel",
    /* The run card at the foot of the transcript: waiting to start, or how long
       the search has been going. */
    notStarted: "Not started",
    working: "Optimising",
    elapsed: (seconds: number) => {
      const whole = Math.max(0, Math.floor(seconds));
      if (whole < 60) return `${whole}s elapsed`;
      const minutes = Math.floor(whole / 60);
      if (minutes < 60) return `${minutes} min elapsed`;
      const rest = minutes % 60;
      return rest === 0
        ? `${Math.floor(minutes / 60)} h elapsed`
        : `${Math.floor(minutes / 60)} h ${rest} min elapsed`;
    },
    autoPace: "Auto",
    autoPaceTitle: "Started without pausing at checkpoints",

    /* The checkpoint card's own chrome. The title and body are the model's
       words and arrive in the conversation's language already. */
    checkpoint: {
      eyebrow: (step: number, total?: number) => (total === undefined ? `Checkpoint ${step}` : `Checkpoint ${step}/${total}`),
      /* A card nobody is asked to approve is not a checkpoint: it records a step
         that is already done, so it is not called one and carries no badge. */
      stepEyebrow: (step: number, total?: number) => (total === undefined ? `Step ${step}` : `Step ${step}/${total}`),
      /* The band across the top of the card: what this card is waiting for on
         the left, which step it is on the right. */
      headerWaiting: "Checkpoint waiting for you",
      headerAnswered: "Checkpoint answered",
      headerStep: "Step",
      count: (step: number, total?: number) => (total === undefined ? `${step}` : `${step}/${total}`),
      confirm: "Looks right — continue",
      adjust: "Needs a change",
      /* "Needs a change" opens a labelled box inside the card; the confirm
         button stays dark until something is written in it. */
      adjustLabel: "What to change",
      adjustPlaceholder: "Describe the change, e.g. score this step more strictly.",
      /* Every confirmation reading the same left the model unable to tell which
         step it was answering; naming the step in the reply fixes that. */
      confirmReply: (step: number, total?: number) =>
        total === undefined ? `Confirm checkpoint ${step}, continue.` : `Confirm checkpoint ${step}/${total}, continue.`,
      autoContinue: (step: number, total?: number) =>
        total === undefined ? `Continue with step ${step}.` : `Continue with step ${step}/${total}.`,
      /* The other shape of the same stall: no card to continue from, and the
         turn simply ended before the search existed. */
      autoResume: "Finish the remaining checkpoints and call create_evolve_run to start the search. Do not stop before the search starts.",
      /* The same step ending twice is where the client stops carrying: one
         more push would be a paid turn answering a card that was already
         answered. The card says so — nothing else on screen moves. */
      autoStopped: "Auto-continue stopped",
      autoStoppedHint: "This step was already carried forward once, so the client will not push it again. Reply to carry the design on.",
      adjustDraft: "I'd like to change this step: ",
      busy: "This reply is still running; wait for it to finish.",
    },

    create: {
      title: "New evolution run",
      algorithmLabel: "Choose a search algorithm",
      puctName: "PUCT",
      puctTags: ["Refines step by step", "Narrow search space"],
      puctPoints: [
        "PUCT expands the nodes most likely to pay off first",
        "Grows from the root one step at a time, keeping every candidate",
        "Visit counts and rank steer where the search goes next",
        "A single tree keeps refining the candidates it holds",
      ],
      openEvolveName: "OpenEvolve",
      openEvolveTags: ["Wide search space", "Avoids early convergence"],
      openEvolvePoints: [
        "A MAP-Elites grid keeps a diverse set of good candidates",
        "Populations evolve independently and swap elites regularly",
        "Ring migration spreads good designs across populations",
        "Mutations reference the global best and distinct candidates",
      ],
      settingsLabel: "Settings",
      confirmLabel: "Pause at each checkpoint",
      confirmHint: "Each checkpoint stops and waits for your confirmation before continuing.",
      autoHint: "Off: the assistant designs and starts the search in one pass. Checkpoints are still shown, but it does not wait for you.",
      taskLabel: "Task",
      taskPlaceholder: "The task to evolve, with its constraints and how it is scored. For example: write a compressor and decompressor for text whose round trip is exactly lossless; the score is how much smaller the output gets.",
      parametersLabel: "Custom evolution parameters",
      parametersHint: "Set a starting value for each parameter. The search tries different values for ticked ones; unticked ones always keep their starting value.",
      /* Windows has no bwrap/seatbelt. There is no switch here, only two
         warnings: a banner under the title so the risk is seen at a glance,
         and an alert that asks again when the search is started. The answer
         travels with this one command (`--allow-direct`); it never becomes a
         setting someone sets once and forgets. */
      unisolatedBannerTitle: "This search runs candidate code without a sandbox",
      unisolatedBannerBody: "This machine has no usable sandbox. Candidates run as you: they can read and write your files, reach the network, and have no CPU or memory limits. You will be asked once more when you click “Start designing”.",
      unisolatedConfirmTitle: "Run candidate code without a sandbox?",
      unisolatedConfirmBody: "The search will execute candidate programs directly: no sandbox, no CPU or memory limits, and access to your files and network. Continue only if you understand those risks and accept them.",
      unisolatedConfirmCancel: "Cancel",
      unisolatedConfirmClose: "Close",
      unisolatedConfirmContinue: "Continue anyway",
      send: "Start designing",
      cancel: "Cancel",
      blockedRunning: "This session is already running; wait for it to finish before starting another.",
      blockedSearch: "This session already has a search running. Open it from its card in the conversation, or wait for it to finish before starting another.",
      blockedArchived: "An archived session cannot start a new run.",
    },

    /* The runtime is not usable. A person on a desktop can only read files and
       click a button, so this names the paths this product actually writes on
       Windows and the actions that actually exist. */
    setup: {
      bannerTitle: "The optimization process is unavailable; results may not be what you expect",
      bannerInstalling: "The optimization process is being prepared; you can start designing when it finishes",
      bannerAction: "View details",
      title: "The evolution runtime is unavailable",
      introMissing: "This machine has not installed the evolution runtime yet. Once it is installed, this message and “Start designing” recover on their own.",
      introError: "The evolution runtime did not start, or the local service could not authenticate to it.",
      introInstalling: "The evolution runtime is being prepared. This message and “Start designing” recover when it finishes.",
      statusLabel: "Reported by the local service",
      whereTitle: "Start with the logs",
      logs: [
        {
          path: "%USERPROFILE%\\.sciencediscovery\\logs\\api.log",
          what: "The local service log; the error at the end names the step the install or start-up stopped at.",
        },
        {
          path: "%USERPROFILE%\\.sciencediscovery\\logs\\evolve.log",
          what: "The evolution engine's own log; read this when the engine starts but is still unusable.",
        },
        {
          path: "%USERPROFILE%\\.sciencediscovery\\evolve",
          what: "The runtime install folder; a missing folder or missing files means the install did not finish.",
        },
        {
          path: "<install folder>\\logs\\shell.log",
          what: "The desktop start-up log, by default in %LOCALAPPDATA%\\Programs\\ScienceDiscovery\\logs; read this when the app cannot reach the local service.",
        },
      ],
      whyTitle: "Common causes",
      whyBody: "First use with no runtime installed; the install was closed midway, or the evolve folder was deleted; a proxy or network failure blocked the download; less than 1 GiB of disk space is free; the deployment does not allow automatic installation.",
      fixTitle: "How to recover",
      fixBody: "Click “Prepare runtime” below to download and install again. If it was installed before and is broken, quit the app, delete %USERPROFILE%\\.sciencediscovery\\evolve, and install again. If it still fails, check the network and disk against the error at the end of api.log, then restart the app and try once more.",
      operator: "This deployment does not allow automatic installation. Ask an administrator to enable program evolution on the server; the status and logs above can be handed over as they are.",
      installing: "Preparing…",
      install: "Prepare runtime",
      close: "Close",
    },

    panel: {
      eyebrow: "Program evolution",
      close: "Close",
      stop: "Stop",
      stopping: "Stopping…",
      /* Between the stop request and the run settling, the card says what is
         still being wound down; otherwise those seconds look like nothing
         happened. Deliberately not a count: `selected` means the parent under
         puct and the new candidate under openevolve, and a discarded proposal
         never emits `expanded`, so the log has no trustworthy in-flight number
         and one would be a promise that never falls. */
      stoppingDetail: "Finishing the in-flight candidates…",
      stopHint: "Candidates found so far remain available after stopping.",
      fullscreen: "Full screen",
      exitFullscreen: "Exit full screen",
      fullTask: "Show the full goal",
    },

    status: {
      pending: "Queued",
      running: "Running",
      succeeded: "Succeeded",
      stopped: "Stopped",
      budget_exhausted: "Budget used up",
      failed: "Failed",
    },

    /* A card that says only "Failed" leaves the user unable to tell their own
       goal/evaluator from a service restart. The reason is translated from the
       machine-readable code; an old record with no reason says so plainly. */
    failure: {
      service_restart: "The service restarted and interrupted the search",
      sidecar_disconnected: "Lost the connection to the search process",
      sidecar_unavailable: "The search process is temporarily unavailable",
      search_failed: "The search or its evaluation failed",
      unknown: "No failure reason was recorded",
    },
    retry: "Retry",
    retrying: "Retrying…",
    retryFailed: "Retry failed; try again in a moment",

    metric: {
      best: "Best score",
      baseline: "Baseline",
      test: "Held-out test",
      candidates: "Candidates",
      depth: "Max depth",
    },

    /* The task detail: the right column's 任务 tab. The three handoffs set the
       order — overview, chart, tree and budget — and the node list and the tree
       are two readings of the same candidates. */
    detail: {
      best: "Best",
      valid: "Valid / total",
      generations: "Generations",
      algorithm: "Algorithm",
      tokens: "Token",
      chartTitle: "Live search results",
      treeTitle: "Search tree",
      nodeList: "Nodes",
      generation: (depth: number) => `Gen ${String(depth).padStart(2, "0")}`,
      bestTag: "Best",
      budgetTitle: "Budget",
      score: "Score",
      children: "Children",
      source: "Code changes",
      expandSource: "Expand code changes",
      closeInspector: "Close node details",
      closeSource: "Close code changes",
      nodeTitle: (index: number) => `Node #${index}`,
      root: "Baseline",
      treeEmpty: "No nodes yet.",
      treeAria: (count: number) => `Search tree with ${count} nodes`,
    },

    chart: {
      title: "Live search results",
      aria: (baseline: string, best: string, candidates: number) =>
        `Score chart: baseline ${baseline}, current best ${best}, ${candidates} candidates.`,
      xAxis: "Expansions",
      best: "Best so far",
      significant: "Scored",
      test: "Test",
      failed: "Failed",
      belowBaseline: "Below baseline",
      baseline: "Baseline",
      empty: "No scores to plot yet.",
    },

    inspector: {
      parent: "Parent",
      depth: "Depth",
      loading: "Reading source…",
      unavailable: "Source unavailable (it may have been pruned).",
      unchanged: "Identical to the parent.",
      noParent: "This is the baseline; it has no parent.",
      error: "Failure",
      hidden: (count: number) => `${count} unchanged lines folded`,
    },

    budget: {
      tokens: "Tokens",
      elapsed: "Elapsed",
      nodes: "Nodes",
    },

    notice: {
      placeholder: "This run used a placeholder scorecard, not one designed for it.",
    },
  },

  ideaTree: {
    heading: "Idea Tree research",
    empty: "This session has no Idea Tree research yet.",
    unavailable: "The Idea Tree service is not ready: start the Evolve service and come back.",
    objective: "Objective",
    legacyCard: "Legacy hypothesis tree",
    legacyHint: "This session's tree comes from an earlier version. It is readable here; the desktop cannot advance it.",
    legacyCount: (nodes: number) => `${nodes} nodes`,
    retry: "Retry",
    endConfirm: "Ending cannot be undone; the nodes it already grew stay.",
    status: {
      running: "Running",
      pausing: "Pausing",
      paused: "Paused",
      interrupted: "Interrupted",
      completed: "Completed",
      ended: "Ended",
      budget_exhausted: "Ended (budget used up)",
    },
    phase: {
      preflight_research: "Preparing",
      building_tree: "Building the tree",
      executing_leaf: "Executing a leaf",
      aggregating_score: "Aggregating scores",
      propagating_insight: "Propagating insight",
    },
    round: (round: number) => `Round ${round}`,
    batch: (done: number, total: number) => `${done}/${total} this round`,
    tokens: (tokens: number) => `${tokens} tokens`,
    tokensUnknown: "Token usage not reported",
    reason: (reason: string) => reason,
    budgetExhausted: (used: number | null, limit: number | null) => {
      const spent = used === null ? "used tokens were not reported" : `${used} tokens used`;
      const cap = limit === null ? "no limit set" : `limit ${limit} tokens`;
      return `The token budget is used up and the research has ended (${spent}, ${cap}). To keep exploring, raise the token limit and start a new research.`;
    },
    pause: "Pause",
    resume: "Continue",
    end: "End",
    open: "Open the task panel",
    create: {
      title: "Start an Idea Tree research",
      hint: "It runs in the background; open its card to see the tree, the nodes and the controls.",
      taskLabel: "Research task",
      taskPlaceholder: "One sentence on the question and its acceptance bounds",
      settingsToggle: "Settings",
      settingsHint: "Off uses the stored defaults.",
      start: "Start research",
      starting: "Starting…",
      cancel: "Cancel",
      failed: "Starting failed.",
      unavailable: "The Idea Tree service is not ready: start the Evolve service and retry.",
    },
    detail: {
      title: "Node detail",
      tree: "Hypothesis tree",
      empty: "This research tree has no nodes yet.",
      unavailable: "Unavailable",
      notPruned: "Not pruned",
      statusLabel: "Status",
      searchLabel: "Search",
      score: "Score",
      priority: "Priority",
      design: "Design",
      aggregate: "Aggregate",
      assessments: "Assessments",
      insight: "Insight",
      pruneReason: "Prune reason",
      artifacts: "Artifacts",
      status: {
        pending: "Pending",
        running: "Running",
        done: "Done",
        needs_retry: "Needs retry",
        failed: "Failed",
      },
      search: {
        active: "Still searching",
        pruned: "Pruned",
      },
      kind: {
        direction: "Direction",
        candidate: "Candidate",
      },
    },
  },
  runFailure: {
    title: "Run failed",
    titles: {
      timeout: "Run timed out",
      "rate-limited": "Model request limit reached",
      "semantic-error": "Unexpected run error",
      "server-error": "Model service error",
      "transport-error": "Model connection failed",
      unauthorized: "Model authentication failed",
      "invalid-tool-call": "Invalid tool call",
    },
    timeout: "The run timed out and was terminated. Retry, or check the relevant timeout in System settings.",
    timeoutNoticeTitle: "Timeout notice",
    timeoutNotice: "A timeout was reported. Open the technical details to identify the affected operation and check the relevant timeout setting.",
    timeoutTitles: {
      gateway_idle: "Run timed out",
      gateway_turn: "Run timed out",
      permission_wait: "Permission wait timed out",
      runner_exec: "Tool execution timed out",
      kernel_idle: "Kernel idle timeout",
    },
    timeouts: {
      gateway_idle: (seconds: number) => `The Agent made no progress for ${seconds} ${seconds === 1 ? "second" : "seconds"}, so the run was terminated. Retry, or increase the Agent idle timeout in System settings.`,
      gateway_turn: (seconds: number) => `The Agent turn exceeded ${seconds} ${seconds === 1 ? "second" : "seconds"}, so the run was terminated. Split the task and retry, or increase the turn timeout in System settings.`,
      permission_wait: (seconds: number) => `The permission request was not handled within ${seconds} ${seconds === 1 ? "second" : "seconds"}, so the run was terminated. Retry and respond to permission requests promptly, or increase the permission wait timeout in System settings.`,
      runner_exec: (seconds: number) => `Tool execution exceeded ${seconds} ${seconds === 1 ? "second" : "seconds"}. Reduce the work per execution and retry, or increase the execution timeout in System settings.`,
      kernel_idle: (seconds: number) => `The kernel was idle for ${seconds} ${seconds === 1 ? "second" : "seconds"}. Retry, or increase the kernel idle timeout in System settings.`,
    },
    "rate-limited": "The model service is limiting requests because a request or usage limit was reached. The run has stopped. Retry later; if this persists, check the provider's limits and available quota.",
    // The backend uses semantic-error as a catch-all; do not assert a cause.
    "semantic-error": "An unexpected issue prevented the task from completing. Retry; if this persists, open the technical details to investigate.",
    "server-error": "The model service returned a server error and the run has stopped. Retry later; if this persists, check the service status or switch models.",
    "transport-error": "The model service could not be reached and the run has stopped. Check your network, proxy settings and model service URL, then retry.",
    unauthorized: "The model service rejected the credentials and the run has stopped. Check the API key and access permissions in System settings' model registry, then retry.",
    "invalid-tool-call": "The model's tool call arguments could not be parsed. That call was not executed and the run has stopped. Retry; if this persists, switch models.",
    unknown: "The task stopped before it could finish. Retry; if it fails again, open the technical details to investigate.",
    technicalDetails: "Technical details",
  },

  errors: {
    generic: "Something went wrong",
    sessionCreate: "Could not create the session",
    noStream: "The response has no readable stream",
    modelUnavailable: "Selected model deleted; choose another",
    modelSignInRequired: "Sign in with HUAWEI ID to use the credits model",
    modelRequired: "No model is available yet. Configure one in Settings.",
    rename: "Rename failed",
    deleteWarning: (title: string) =>
      `Deleting "${title}" also removes its workspace data, and cannot be undone.`,
    archivedBanner: "This session is archived and read-only. Restore it to send messages and run again.",
    archivedComposer: "An archived session cannot send messages. Restore it to continue.",
    archiveBlockedByRun: "This session is running. Wait for it to finish before archiving or restoring.",
    archiveTearsDownKernel: "Archiving stops the scientific kernels it is running, and memory not yet on disk does not come back with it.",
    deleteProjectWarning: (name: string) =>
      `Deleting the project "${name}" also removes its sessions, their workspaces and their artifacts, and cannot be undone.`,
  },

  status: {
    localOnline: "Local runtime · Online",
    localDegraded: "Local runtime · Degraded",
    localOffline: "Local runtime · Offline",
  },

  feedback: {
    entry: "Send feedback",
    dialogTitle: "Send feedback",
    selectPlaceholder: "Select one",
    requiredHint: "Frequency and impact are required",
    close: "Close",
    tab: {
      compose: "Compose",
      history: "My feedback",
    },
    kind: {
      label: "Type",
      bug: "Report a problem",
      idea: "Suggest an idea",
      other: "Other",
    },
    body: {
      label: "Description",
      placeholder: "Describe what happened or your idea (10–2000 characters)",
      counter: (count: number, max: number) => `${count}/${max}`,
      tooShort: (min: number) => `Please write at least ${min} characters`,
    },
    contact: {
      label: "Contact (optional)",
      placeholder: "Email or GitHub username",
      invalid: "This does not look like an email or GitHub username",
    },
    reproducibility: {
      label: "Frequency",
      always: "Always",
      sometimes: "Sometimes",
      once: "Once",
    },
    impact: {
      label: "Impact",
      blocker: "Unusable",
      major: "Slows down my work",
      minor: "Affects the experience",
    },
    diagnostics: {
      label: "Attach diagnostics",
      preview: "Preview what will be sent",
      none: "No diagnostics available for this feedback",
    },
    images: {
      label: "Screenshots (optional)",
      add: "Upload image",
      limit: (max: number) => `Up to ${max} images`,
      remove: "Remove screenshot",
      preparing: "Processing images…",
      truncated: (max: number, skipped: number) => `Only the first ${max} screenshots were attached; ${skipped} skipped.`,
      privacy: "Screenshots are visible to anyone with repository access; hide sensitive information first.",
      error: {
        type: "Only PNG, JPEG or WebP images are supported.",
        size: "This image is still too large after compression.",
        decode: "This image could not be read.",
      },
    },
    submit: "Submit",
    submitting: "Submitting…",
    success: {
      title: "Thank you",
      note: "Here is your receipt. We use it to update you on progress.",
      copyReceipt: "Copy receipt",
      copied: "Copied",
      done: "Done",
    },
    failure: {
      network: "Could not reach the feedback service. Your draft is kept.",
      timeout: "The request timed out. Your draft is kept.",
      forbidden: "The service rejected this request.",
      rateLimited: "You submitted too quickly. Please wait a bit and try again.",
      duplicate: "This feedback was already submitted.",
      tooLarge: "The message is too long. Shorten it and try again.",
      unavailable: "The service is temporarily unavailable. Please try again later.",
      invalid: "Some fields need attention.",
      fieldsTitle: "What needs attention",
      kept: "Your draft is kept; you can copy it or open a GitHub issue instead.",
      copyAll: "Copy everything",
      openIssue: "Open GitHub issue instead",
    },
    back: "Back",
    history: {
      empty: "No feedback submitted yet",
      delete: "Delete",
      status: {
        submitted: "Submitted",
      },
    },
    pii: {
      warning: (kinds: string) => `This looks like it may contain personal information (${kinds}). Please remove it or confirm it is safe to send.`,
      confirm: "I confirm this is safe to send",
      phone: "phone number",
      idCard: "ID number",
      email: "email",
    },
  },
};
