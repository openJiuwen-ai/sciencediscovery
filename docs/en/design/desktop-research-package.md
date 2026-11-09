# Desktop research package delivery design

Status: desktop implementation rebased onto main `59f10f97`, which includes #498. Related requirements: #803. Export/import, copy and branch controls consume the merged backend contracts and schema. Full shipping-stack and model-follow-up journeys remain required before merging.

Preview the actual desktop application against the #498 backend. The standalone component preview has been removed. Browser reload recovery for background operations and full shipping-backend journeys remain open.

## Goal and delivery boundary

Deliver necessary/complete evidence export, import, correct evidence inspection, writable continuation and branching from intermediate completed replies in apps/desktop. Reuse the backend contracts from #498 after they settle. Environment recreation, automatic experiment reruns and numerical comparison are outside scope.

## User interface

- Session row menu: place Export conversation between Rename and Delete. Export the whole Session's research through #498, not rendered chat text. Show necessary/complete cards, each with a description, estimated uncompressed size and content summary. Keep detailed omissions collapsed.
- New conversation: retain the existing create action and add a fine-line chevron that reveals Import conversation on hover or keyboard focus. Project `+` remains unchanged. Import defaults to no project (the inbox), with an optional existing-project selector in the import dialog.
- Imported conversation: preserve the evidence snapshot and open it as a read-only session. An eligible snapshot offers Continue chatting, which creates and opens an independent writable continuation only when the user asks for it; a terminal failure uses a new idempotency key. Unavailable snapshots explain why continuation is disabled. Read-only snapshots never offer branching.
- Completed reply menu: Create branch chat uses that reply as the boundary. Preserve only the prefix through the selected reply and attributable evidence; exclude later turns. Keep the original unchanged and show the chosen reply in confirmation.
- Background operation indicator: export/import/continuation progress, cancellation where supported, failure/retry and completed download/open actions. Navigation must not hide running operations or steal focus on completion.
- Reuse existing file/artifact/provenance and trajectory surfaces. Explain omitted or unavailable historical material instead of substituting current files or presenting unexplained errors. Scientific-memory UI follows the desktop surface; no new graph canvas is required.

## Module integration

- apps/desktop/src/api: add a research-package client adapter using client.ts and the settled HTTP contracts from #498; reuse sessions.ts for conversation state and branch operations where appropriate.
- apps/desktop/src/views and app: integrate project/session menus, dialogs, snapshot notice, background operation indicator and reply actions with the existing shell. Final file names depend on current component ownership.
- apps/desktop/src/state and run-stream: reuse the schema's read-only helper; refresh session lists after import/copy/branch before navigating. Model-catalog refresh is separate.
- apps/desktop/src/text/zh.ts and en.ts: paired strings for profiles, omissions, progress, recovery and source navigation.
- packages/schema, research-package, trajectory, CAS and services/api: consume #498 contracts and preserve version/source semantics; no second archive implementation or desktop-owned session store.
- Existing scientific-memory/artifact viewers: reuse available integration, report missing services accurately, distinguish a package without a graph from one whose graph failed restoration.

## Implementation checklist

- [x] Rebase onto main including #498; consume schema types and read-only helper.
- [ ] Implement typed clients, browser/Electron file selection and download handling through existing desktop infrastructure.
- [ ] Implement export/import dialogs and revision-correct previews.
- [ ] Implement read-only snapshot inspection and writable continuation with inherited context/files.
- [ ] Implement intermediate branching and persistent immediate-source navigation.
- [ ] Implement operation tracking, reload/retry, stale revision and actionable configuration/service failures.
- [ ] Complete localization and UI review, including narrow-window layout.

## Test design

Unit: profile/option payloads, operation reduction, stale preview rejection, read-only state and source-link mapping.
Component: profile toggles, pending/failed preview, import confirmation, snapshot notice, progress after navigation, reply branching, file inspection and omitted-evidence messaging.
Desktop E2E (proposed research-package.spec.ts): necessary and complete export/import against isolated data; inspect messages/files/logs/trajectory; create continuation and send a follow-up that uses an inherited fact/file; branch midway and prove later messages/versions absent; branch again and restart; verify source unchanged; retry and navigate during background operations; damaged package, busy source, missing local model and graph-unavailable paths.
Use the shipping executor, pinned browser preparation and numbered journey reports. Mocked-model checks must assert inherited material reaches the follow-up path. Add a bounded real-model import/continue/branch journey before claiming real operation; absent prerequisites are coverage gaps.
Run desktop typecheck/unit/E2E and required repository UT/ST/E2E gates on the exact implementation commit; record counts and blocked conditions. The desktop regression suite covers failed-operation retries, sidebar navigation, snapshot capabilities, inspection-cache reuse, missing projects and stacked Escape handling. Bilingual read-only, export-preparing and simulated export-failure screenshots are captured by the state journeys.

## Merge gate

Do not merge this draft. Before readiness: #498 merged; remaining lifecycle and navigation details implemented; settled API compatibility checked; UI reviewed; necessary/complete handoff, inherited follow-up, intermediate branch and restart journeys passed with evidence. This PR must not automatically close #803 while required delivery remains incomplete.
