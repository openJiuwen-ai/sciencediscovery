# Desktop artifact recovery and expansion

Version: 1 — 2026-11-23. Increment to #1257; refs #1202 and PR #1228.

## Scope

Keep `TurnArtifactStrip`, its card presentation, `turnArtifactsByRun`, and its
exact-version panel preview from #1257. Do not introduce another artifact list,
selector, or public API. This design replaces the earlier full-width-list
proposal retained in PR #1228's previous commits.

## Requirements

- **AR-1 — durable attribution.** Retain the terminal SessionRun rows independently
  of event replay, with the same Session/epoch guards and bounded cache. A version
  must belong to the active Session and resolve through the existing turn/subagent
  selector. Unknown or cyclic lineage stays excluded.
- **AR-2 — recovery.** When replay cannot provide a subagent's lineage, read the
  existing subagent catalog. Reuse a successful read for the same client, Session
  and origin set; retry a failed read on the next successful outputs refresh,
  including another version from the same child. A Session switch or client change
  must not publish an older read into the new conversation.
- **AR-3 — one anchor.** A terminal run has one artifact strip. Prefer its replayed
  answer; otherwise use its stored assistant message. If neither answer survives,
  put the existing strip under the run's status after its starting message. Runs
  without eligible outputs gain no synthetic turn. Active/blocked runs gain no
  artifact strip, even if their event connection has ended. Preserve cancellation,
  failure and per-turn usage presentation.
- **AR-4 — inline expansion.** Keep #1257's ordering and initial important-kind
  selection, with at most five file cards. The overflow card expands the remaining
  files in the same strip, including intermediate kinds, and offers collapse. The
  artifact panel remains reachable. Both disclosure controls identify the list
  with `aria-controls`, expose `aria-expanded`, and transfer keyboard focus to
  their counterpart when toggled. Every card still opens the exact saved version.
- **AR-5 — evidence.** Use the retained card UI in English and zh-CN. Cover pruned
  and failed event reads, no-answer completed/failed/cancelled runs, catalog failure
  followed by same-child recovery, live-to-replay deduplication, Session switching,
  historical v1/v2 selection, overflow/collapse and long names in a narrow window.
  Record the immutable tested head and refresh PR screenshots after integration.

## Acceptance and validation

The desktop browser journey must show only one strip per eligible terminal run,
recover without reopening the Session after a temporary catalog failure, and open
different historical contents from v1/v2 cards. Selector/hook tests cover Session
isolation, stale asynchronous reads and cached-success reuse. Existing grouping,
ordering and panel interaction tests remain applicable.

Run desktop typecheck/unit/browser checks and the repository's required WSL
validation. Report actual results, policy skips and environment blockers separately.
The PR description credits #1257's existing behavior and uses `Refs #1202` until
the remaining issue acceptance is established against the integrated implementation.
