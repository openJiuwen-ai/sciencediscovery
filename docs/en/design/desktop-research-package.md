# Desktop research package delivery design

Status: initial desktop UI implementation; do not merge. Depends on #498 (observed head 4390b236299be0ae3c1a692eb69fae2da2515d12). Related requirements: #803. Export/import, copy and branch controls are now wired to the proposed backend routes. Full backend journeys remain unverified.

Local interaction preview: run the desktop Vite server and open `/e2e/research-preview.html`. This development-only fixture renders the production ResearchPackage component with explicitly simulated responses. It does not validate archive restoration or model continuation. Browser reload recovery for background operations, per-reply source anchoring, and full shipping-backend journeys remain open.

## Goal and delivery boundary

Deliver necessary/complete evidence export, import, correct evidence inspection, writable continuation and branching from intermediate completed replies in apps/desktop. Reuse the backend contracts from #498 after they settle. Environment recreation, automatic experiment reruns and numerical comparison are outside scope.

## User interface

- Session menu: export research package. Show necessary/complete profile, file selection, included/omitted counts, size preparation, independent full trajectory and scientific memory options. Reflect the actual revision and never present stale size as final.
- Project/empty-conversation entry: import a .sdresearch file, inspect scope and omissions, confirm destination, follow restoration and open the read-only record. File selection/drop is distinct from attaching a file to a normal chat.
- Imported conversation: show a persistent read-only notice and Create a new session to continue research. Use an independent writable copy; inherited files and context must be available to follow-up turns under local model/permission settings.
- Completed reply menu: Branch to a new chat in an eligible writable conversation. Preserve only the prefix and attributable evidence through that reply. Imported snapshots first require a writable copy. Keep source navigation after reload and support branching a branch.
- Background operation indicator: export/import/continuation progress, cancellation where supported, failure/retry and completed download/open actions. Navigation must not hide running operations or steal focus on completion.
- Reuse existing file/artifact/provenance and trajectory surfaces. Explain omitted or unavailable historical material instead of substituting current files or presenting unexplained errors. Scientific-memory UI follows the desktop surface; no new graph canvas is required.

## Module integration

- apps/desktop/src/api: add a research-package client adapter using client.ts and the settled HTTP contracts from #498; reuse sessions.ts for conversation state and branch operations where appropriate.
- apps/desktop/src/views and app: integrate project/session menus, dialogs, snapshot notice, background operation indicator and reply actions with the existing shell. Final file names depend on current component ownership.
- apps/desktop/src/state and run-stream: reconcile session creation, read-only guards and selection changes without duplicating backend authority or altering ordinary turn rendering.
- apps/desktop/src/text/zh.ts and en.ts: paired strings for profiles, omissions, progress, recovery and source navigation.
- packages/schema, research-package, trajectory, CAS and services/api: consume #498 contracts and preserve version/source semantics; no second archive implementation or desktop-owned session store.
- Existing scientific-memory/artifact viewers: reuse available integration, report missing services accurately, distinguish a package without a graph from one whose graph failed restoration.

## Implementation checklist

- [ ] Wait for #498 merge, rebase onto upstream main, inspect any changed contracts and update this design.
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
Run desktop typecheck/unit/E2E and required repository UT/ST/E2E gates on the exact implementation commit; record counts and blocked conditions. No product tests have been run for this design-only commit. The local checkout predates apps/desktop and the current host is Windows; no passing implementation validation is claimed.

## Merge gate

Do not merge this draft. Before readiness: #498 merged; remaining lifecycle and navigation details implemented; settled API compatibility checked; UI reviewed; necessary/complete handoff, inherited follow-up, intermediate branch and restart journeys passed with evidence. This PR must not automatically close #803 while required delivery remains incomplete.
