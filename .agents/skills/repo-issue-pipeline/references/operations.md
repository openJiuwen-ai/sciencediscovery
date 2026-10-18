# Operating a configured pipeline

Use these procedures for the main-agent role. They are instance-neutral; load the user's confirmed settings from the selected task directory.

## Startup agreement and periodic task

Before starting, confirm upstream/fork/base, Issue eligibility/exclusions, maximum active SDK workers, inspection frequency/timezone and record/workspace location. Record the agreement in active-tasks.md. Do not infer fixed repository addresses, a one-worker cap or a ten-minute interval from examples or another installation.

Use the product/environment's periodic-task capability to wake the MAIN agent at that interval. Discover its actual supported scheduling and session-target behavior before configuring it. The wake-up message identifies the skill and absolute task-record paths, asks the main agent to reconcile live state and perform one inspection/dispatch/review pass, and reminds it to honor the confirmed worker cap. It contains no credentials.

Persist the schedule ID and verify enabled state, next execution and the actual first main-agent inspection. Record last successful inspection and any missed runs. Skills are instructions, not an always-running process; a long sleep in a chat turn is not a persistent periodic task. If multiple wake-ups overlap, inspect the existing coordinator and coalesce rather than run competing schedulers. Any small SDK launcher or service wrapper handles transport/process/log persistence only; task selection, retry decisions and review judgments remain with the main agent.

Where supported, use worker completion notifications to wake/coalesce a main-agent pass promptly; the periodic inspection remains the recovery fallback. A notification carries task/session identity and an outcome/report pointer only, never selects work or bypasses the cap/single ledger writer. A wake arriving during an active inspection must remain observable for reconciliation; do not assume a redundant service start guarantees another turn. Configure/test the available facility before calling completion-driven scheduling active. Without it, disclose timer-only operation rather than inventing a webhook/event guarantee.

## Active task record

Use a short configuration header plus one readable section per task. Maintain fields only when known; an unknown value is not an invented fact.

Configuration header:

- pipeline identity; upstream/fork/base and authenticated workflow account;
- eligibility rule and explicit inclusions/exclusions;
- user-confirmed maximum workers and inspection schedule/timezone;
- confirmed authorization/resource/cost constraints;
- confirmed time/source, schedule ID, last successful inspection.

Task section:

- stable task ID, Issue/associated PR URLs, current ownership/admission evidence;
- accepted scope and explicit deferrals;
- acceptance checklist linking delivered criteria to current-main/PR/test evidence and all remaining work to queued next actions or explicit blocker/resume conditions; track merged-PR delivery separately from full Issue completion;
- verification of the current problem/gap: upstream SHA, reproduction/probe conditions and evidence, or not-reproduced/unable-to-test disposition with public comment and resume condition;
- current progress and next action; reason if waiting/blocked;
- ready-since time, priority/aging and last meaningful progress; changed source revision, observed change, judgment, next action, responsible actor and blocker/resume condition;
- last remote check/progress time and current branch/head;
- worker thread ID and process/service identity, worktree, logs and report;
- relevant CI run/head/status, approvals, unresolved discussions and actual merge-queue evidence;
- questions and authoritative decision/disposition URLs.

Separate unclaimed/competing-work candidates from admitted work even if they are listed in the same active file. Main-agent-only ledger writes avoid competing updates from workers. Reconcile with live evidence before allocating the confirmed worker slots.

Keep active-tasks.md compact: current settings/exclusions, current task/queue state and linked requirement evidence only. Put append-only inspection narratives/raw discussion/test artifacts in linked logs; preserve an archival copy before any compaction and retain every unfinished scope/decision/ownership/session reference. Do not reread the entire history on each poll. Refresh the current index and changed sources; completed records need relevant outcome/index checks, not repeated full acceptance audits of unchanged deliveries. No extra script-driven business state machine is required.

Persist complete initial discussion snapshots with source IDs, relevant content/revisions/hashes, retrieval time and pagination completeness. Incremental comparisons must catch body/comment edits, new reviews and replies on resolved/outdated threads, approval dismissal and queue/head changes; a single parent timestamp or latest-N slice is insufficient. Use reliable API freshness checks where available and full fallback where not. Associate CI with head/run/attempt and dependencies; store raw data once, feed changed excerpts plus authoritative current decisions to the model. Helpers may fetch/cache/compare/notify, but admission, disposition, prioritization and review stay main-agent judgments.

When revisiting third-party-PR holds, query live Issue assignees first. An Issue owned by the workflow account should return to admitted development as needed, even while another contributor's PR is open. Record those PRs as references and audit our own PR against the full accepted Issue scope; do not list unmerged third-party delivery as a prerequisite or completion evidence. Preserve others' PRs and cite reused contributions. If another account owns the Issue or unassigned work has a credible claimant, retain the ownership hold. Apply the same completeness check to already submitted pipeline PRs previously described as complementary partial deliveries.

Admission/ownership does not confirm the defect exists. Before implementation, require evidence of the current reported failure or accepted capability gap on upstream main. Not reproduced or unable to test means a public evidence/clarification comment, a recorded waiting-for-reproduction task and no speculative development. Keep it under observation but dispatch again only for relevant new evidence/conditions. Do not mistake a passing patched branch for a failed baseline reproduction. Existing CI/conflict tasks use their actual current failure/conflict evidence.

## Completed task record

Record task ID, Issue/PR URLs, outcome/time, actual merge/closure evidence, final accepted scope and validation/report links. Record closed-unmerged, withdrawn and no-gap outcomes accurately. Preserve residual scope and link its active task. Use stable task IDs to avoid duplicate archive entries and to recover an interrupted move between the two text files.

An archived PR can coexist with a still-active Issue gap. A deliberately excluded Issue must not be rediscovered as authorized merely because its label remains present. Reopen archived work only on relevant new accepted scope or evidence, after ownership/duplicate checks.

## Progress, recovery and resource checks

Before starting/resuming, verify that no live worker already owns the task. Record process start identity as well as PID to avoid confusing PID reuse with survival. The SDK thread ID supports context continuation, but is not evidence that its host process is alive.

For the same engineering task use SDK resume on the existing thread/worktree/branch/PR, including clarification/CI/conflict/review continuations. A delta assignment states the trigger, new evidence/decision/current revisions, requested outcome and changed boundaries; do not recreate the original full assignment. If replacement is necessary, record the actual thread failure/separate-task reason and a focused handoff. Do not end a healthy worker after every internal design/verification stage; assign full authorized delivery and continue unless real external wait or safe reprioritization requires releasing capacity.

Read recent meaningful progress plus resource use and child processes. Compare with worktree commits, CI and remote PR. On a host restart the thread history may remain even though its process is gone. Resume that thread if useful, otherwise hand off preserved work to a new independent SDK session. Do not hard-reset dirty work or duplicate a PR because a final report is absent.

Keep waiting tasks under periodic observation, including questions posted in Issue/PR comments and CI/merge-queue changes. Avoid using worker slots merely to wait. A full-access worker still shares host CPU/memory; bound relevant test concurrency and coordinate heavy work using an agreed resource lock where necessary.

## Review and reports

The main agent performs independent code/evidence review and can do so while an unrelated worker develops. It must inspect the reported head, not a different local revision, and verify complete substantive discussion dispositions. Preserve evidence for tests not run locally and distinguish remote CI evidence from a local pass.

Measure rather than infer efficiency: when supported record timestamped worker start/resume/end, model request/tool/test intervals, requirement decisions, CI creation/start/end/attempt and queue transitions with task/head links. Separate implementation, review repair, conflict, CI/infrastructure, external decisions, environment/dependency blocks and scheduler wait; allow overlaps without double-counting. Do not log credentials or unredacted request/context payloads, or claim per-operation timings when only turn boundaries exist. This is an observability requirement, not proof that the installed SDK host already emits such events.

Status reports summarize active development, waiting execution, external waits, blocked candidates and newly completed work. Explain an actual blocker or next action for each unfinished task. Changes in PR approval or queue state must come from live repository evidence. Do not imply local reports automatically notify the user or that enabling a periodic task proves useful progress.
