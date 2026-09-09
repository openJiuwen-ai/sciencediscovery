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
| `session/run-activity.ts` | Groups plan/subagent/remote-job/permission/artifact cards by run and calculates anchors/expansion state |
| `Permissions.tsx` | Permission cards and grant management |
| `Orchestration.tsx` | Subagent cards, specialists, and plans |
| `RemoteCompute.tsx`, `ScientificArtifacts.tsx`, `RuntimeControls.tsx`, `EnvironmentManager.tsx`, `SkillManager.tsx`, `MemoryGraphView.tsx` | System and domain panels |
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
| `subagent.updated`, `remote_job.proposed` | Run-scoped activity cards after their timeline/message; collapsed summary by default except pending remote-job approval |
| `artifact_review.completed` | Reviewer Specialist and Artifact result |
| `run.completed`, `run.failed`, `run.cancelled` | Timeline finalization, file refresh, and error banner/toast |

## 5. Development and tests

- `pnpm --filter @sciencediscovery/web dev` starts Vite at `127.0.0.1:5173` and proxies `/api` and `/health` to `127.0.0.1:4310`.
- `tsx --test tests/*.test.tsx` covers reducers, stop flow, composer state, and multi-Session stream isolation.
- User-perspective E2E verifies a user's goal through actual product use, not just the browser. Root `test/` contains pinned Playwright journeys; `pnpm ci:e2e` runs the mocked browser subset. API/CLI/local-stack journeys use the public product entry points and have separate driver commands. Changed UI interactions and layout still need browser coverage, not only API assertions. See [CONTRIBUTING](../../../CONTRIBUTING.md#user-perspective-e2e) for coverage requirements and setup.

## Related documentation

- [Control plane](../explanation/control-plane.md)
- [Runtime architecture](../explanation/architecture.md)
