# Frontend: `apps/web`

The React browser UI is served as static assets by the control API after build and supports independent hot reload in development. It intentionally uses no router or state-management library.

## 1. Stack

- React 19, Vite, `@vitejs/plugin-react`, and plain `styles.css`.
- Markdown through `react-markdown`, GFM, math, and KaTeX plugins.
- Molstar molecular viewer initialized in `molecular.ts`.
- Hand-written routing and React-hook state; `App.tsx` switches top-level views through values such as `activeSessionId`.

## 2. Source layout

| File | Purpose |
|---|---|
| `App.tsx` | Root state shell, Project/Session management, stream listening, and top-level assembly; delegates to feature modules |
| `api.ts`, `api/` | Compatibility barrel plus `ApiClient` and domain clients |
| `timeline/RunTimeline.tsx` | Event reducer and thinking/tool/assistant timeline; old path re-exports it |
| `ProcessRecord.tsx`, `styles/process-records.css` | Live cards, expandable terminal records, Workspace folders, alignment and hover styles; no execution-state changes |
| `SkillReviewRecords.tsx` | Tracks pending reviews by exact draftId, separating pending actions from processed records |
| `session/ConversationArtifactList.tsx` | Per-run outputs, preserving the distinction between fixed Artifact versions and current files |
| `session/run-activity.ts` | Groups plan/subagent/remote-job/permission/artifact cards by run and calculates anchors/expansion state |
| `Permissions.tsx` | Permission cards and grant management |
| `Orchestration.tsx` | Subagent cards, specialists, and plans |
| `RemoteCompute.tsx`, `ScientificArtifacts.tsx`, `RuntimeControls.tsx`, `EnvironmentManager.tsx`, `SkillManager.tsx`, `MemoryGraphView.tsx` | System and domain panels |
| `UsagePage.tsx` | Usage dashboard with model/date filters, token and cost overview, stacked daily bars, filter-scoped drilldown details, and CSV/JSON exports; long date ranges support horizontal drag/scroll, default to the latest dates, and scroll left for older records |
| `ManagementControls.tsx`, `WorkbenchNavigation.tsx` | Lifecycle dialogs, search, and composer references |
| `Markdown.tsx`, `Toasts.tsx`, `icons.tsx` | Rendering infrastructure |

## 3. Server communication

`ApiClient.request()` injects `authorization: Bearer <token>` from local-storage key `sciencediscovery-token`. `streamMessage()` posts `/api/sessions/:id/runs` with `accept: text/event-stream` and manually parses `data: <json>\n\n` through `body.getReader()`, rather than EventSource, to support Authorization and abort.

## 4. Event-to-UI mapping

| Event | UI |
|---|---|
| `agent.phase`, `assistant.thinking.delta`, `assistant.delta` | Thinking/body timeline entries |
| `tool.started`, `tool.completed` | Tool state and summary |
| `tool.output` | Incremental tool substream; details expand on demand |
| `permission.required` | Permission card |
| `plan.updated` | Current Plan per Agent in the right-hand Workspace Tasks section; an empty snapshot removes that Agent's current card while remaining in the persisted event stream |
| `subagent.updated` | Each subtask updates at its initial delegation position, without forced parallel grouping; terminal records expand and retain independent conversation access |
| `remote_job.proposed` | Run-scoped remote-job records; pending approvals retain cards, terminal records expand; historical rendering does not re-enable remote execution |
| `artifact_review.completed` | Reviewer Specialist and Artifact result |
| `run.completed`, `run.failed`, `run.cancelled` | Timeline finalization, file refresh, and error banner/toast |

## 5. Display lifecycle

- A Run has one avatar/model header after the user input and before its thinking/tools. Subsequent prose and process rows share a text alignment.
- Active thinking, tools and other operations retain cards. Terminal entries collapse to gray borderless rows. Failures retain explicit text and an adjacent red dot. Hover/keyboard focus transitions to dark text and respects reduced-motion preferences.
- Expanding a terminal row restores framed details and supports collapse again. Tool input, output and errors expand independently. Folding does not delete events, logs, results or audit records; explicit expansion is not reset by every streaming delta.
- Pending permissions retain decision buttons. Allowed, denied and cancelled requests no longer display permission cards. Only an exact `toolCallId` match adds an authorization label to the running or expanded tool; another tool's grant is not evidence of authorization.
- Governed downloads remain in the conversation. Candidates, pending approvals and active jobs retain actions; terminal details and failed-job retry remain accessible. A plan's `awaiting_approval` is not the permission request's authoritative state. Cancelled requests cannot be approved again; stale plan state after permission cancellation remains a known issue, not fixed by this presentation change.
- Reviewer, Skill summary and draft-review entries follow their own lifecycle, not the parent Run's completion. A draft absent from the pending list is "processed", not necessarily approved; lookup failures do not imply completion.
- Only the latest eligible source Run exposes Skill summarization. Hide an unstarted entry without a writable library, with an archived Session or without a model; existing summary tasks/results remain visible. `project-skills` is a recommendation, not an automatically created library.
- Per-run Artifact cards retain fixed-version access without an additional `Generated result` aggregation card. Undeclared files expose current content only, not an immutable historical version.

## 6. Right-hand Workspace

Top-level folders start open; secondary details and file directories start closed and toggle independently. Inner controls retain their white panels rather than using the conversation's borderless terminal-row styling.

| Folder | Contents and conditions |
|---|---|
| Files | Uploads, Project Artifacts grouped by Session, Workspace files and file provenance; hide empty lists, retain upload |
| Tasks | Current Plans, Evolve, enabled Reviewer controls, executions, transfers and reminders; hide an empty folder while retaining activity polling so new tasks can reveal it |
| Memory | Enabled science-memory summary and graph entry; hide disabled memory, retain empty/unreachable feedback when enabled |

List headers show total counts, not active/total ratios; zero-item lists disappear. Action/configuration entries do not invent counts. Workspace-file multiselect is visible only when expanded, immediately left of the count; selection, download, deletion and provenance actions are preserved.

Plan titles truncate with full hover text, progress occupies a separate line, and badges do not wrap. All steps completed means "Completed"; a terminal Run with unfinished steps means "Finished". Nonempty plans are not automatically "In progress". Empty snapshots still remove the Agent's current Plan.

The standalone Paper reader panel, Provenance statistics card and persistent isolation notice are removed from the rail, not the underlying parsing, audit or isolation capabilities. File counts are totals, not unread badges. Download acknowledgment followed by automatic hiding is not implemented here.

## 7. Development and tests

- `pnpm --filter @sciencediscovery/web dev` starts Vite at `127.0.0.1:5173` and proxies `/api` and `/health` to `127.0.0.1:4310`.
- `tsx --test tests/*.test.tsx` covers reducers, stop flow, composer state, and multi-Session stream isolation.
- Display regressions: `ProcessLifecycle.test.tsx`, `Permissions.test.tsx`, `Orchestration.test.tsx`; browser journeys `journey-compact-process.spec.ts`, `journey-delegate-subtask.spec.ts` and `journey-plan-workspace.spec.ts` cover live/terminal states, independent subtasks, Skill lifecycle, file access, Plan status and narrow layouts.
- User-perspective E2E verifies a user's goal through actual product use, not just the browser. Root `test/` contains pinned Playwright journeys; `pnpm ci:e2e` runs the mocked browser subset. API/CLI/local-stack journeys use the public product entry points and have separate driver commands. Changed UI interactions and layout still need browser coverage, not only API assertions. See [CONTRIBUTING](../../../CONTRIBUTING.md#user-perspective-e2e) for coverage requirements and setup.

## Related documentation

- [Control plane](../explanation/control-plane.md)
- [Runtime architecture](../explanation/architecture.md)
