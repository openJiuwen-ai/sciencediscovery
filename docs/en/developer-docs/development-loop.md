# Development loop: from issue to release evidence

This is an operator-invoked workflow proposal for ScienceDiscovery. The
[development-loop skill](../../../.agents/skills/development-loop/SKILL.md)
turns a queue review into concrete next actions. It installs no daemon, webhook,
schedule, credential, merge rule or CI trigger. Maintainers must approve any
future deployment's cadence, capacity, recipients and write permissions.

The design takes inspiration from Magpie's unified agent/model routing and
reusable instruction library, described in its
[pinned README](https://github.com/yetone/magpie/blob/35aa50cfb33a427681841ca2eb366b0cda5ebdc7/README.md).
That source is not a ScienceDiscovery PR-review policy or an upstream PR-loop
skill. This guide is adapted to ScienceDiscovery's actual contribution and CI
contracts, without adding a dependency on Magpie.

Related work: [PR #231](https://github.com/openJiuwen-ai/sciencediscovery/pull/231)
proposes a focused source-review skill. This loop coordinates queue handoffs and
evidence; it does not replace source review. Until that proposal is accepted
into a trusted revision, treat it as proposed material rather than active policy.

## Three queues

- **Issue implementation:** unclaimed requirements, missing reproductions,
  design decisions and dependencies. Exit: accepted scope, responsible person,
  testable acceptance and linked implementation PR, or an explicit disposition.
- **PR review:** non-draft candidates requiring source review or changed-head
  revalidation. Exit: completed review of the current head, resolved blocking
  concerns and the applicable PR checks. A review request is not an approval.
- **CI and acceptance:** failed/pending/missing evidence, merge-group validation,
  real user journeys and release sign-off. Exit depends on the item's stage;
  PR CI, merge-group CI and release acceptance are distinct results.

An item may have several blockers. Track each blocker, with one next actor and
recheck trigger, rather than moving it to a single opaque "blocked" bucket.
Drafts remain visible as implementation backlog. Merged and closed PRs leave
open-work queues but remain linked to acceptance or regression follow-up.

## Seven decision points

| Node | Blocking question | Next action and responsible role | Exit evidence |
| --- | --- | --- | --- |
| 1. Requirement claim | Is scope, ownership or acceptance missing? | Maintainer confirms scope and owner; contributor links the issue and measurable outcome. | Accepted requirement, owner confirmation, milestone/release impact and acceptance criteria. |
| 2. Design and dependencies | Do overlapping PRs, contracts or baseline choices conflict? | Reviewer identifies overlap; maintainer chooses dependency/merge order; contributor tests the chosen combination. | Linked decision and dependencies; compatible implementation and test plan. |
| 3. Implementation | Is work unfinished, draft, conflicted or unreproducible? | Contributor completes code, rebases conflicts and supplies named regression tests and environment prerequisites. | Non-draft current head, relevant diff and reproducible local evidence. |
| 4. Source review | Is the current head unreviewed or a human concern unresolved? | Reviewer checks implementation, tests, security and contracts; contributor addresses actionable findings. | Head-bound review and evidence for every resolved blocking concern. |
| 5. CI repair | Which exact job failed, and is its cause code, infrastructure or unknown? | Contributor diagnoses code failures and posts repair evidence; reviewer verifies; authorized maintainer decides whether a rerun is needed. | Fix SHA, local command/environment/results and current applicable CI results. |
| 6. Real acceptance | Does the changed user path meet its declared outcome? | Contributor supplies public-safe journey reports; reviewer checks candidate, backend, model/dataset and evaluator identity. | Required case results, coverage and explicit blocked/untested outcomes; unresolved acceptance stays open. |
| 7. Release sign-off | Is release scope validated and are risks accepted? | Release owner records scope, evidence and explicit decisions/waivers under repository policy. | Linked release decision and applicable release results; calendar dates alone do not establish completion. |

"Responsible role" above is a suggested assignment until a person accepts or
an authoritative repository record assigns it. Do not infer ownership from a
name, hardware topic or bot mention. Record verified and suggested owners
separately. Release impact is `confirmed`, `proposed` or `unknown`, with a source;
not every issue blocks the next release.

The [October release tracker (#249)](https://github.com/openJiuwen-ai/sciencediscovery/issues/249)
is an example of the central scope/acceptance record. Read its current contents;
do not hard-code its dates, owners or PR status into the recurring workflow.
Keep reusable policy here and dated evidence on the relevant issue/PR or in an
operator-authorized report. Link detailed PR TODOs from a roadmap only when
posting there is authorized. An agenda proposal is not an agreed release gate.

## ScienceDiscovery gates and reruns

Read [CONTRIBUTING](../../../CONTRIBUTING.md),
[the CI contract](../../../.ci/README.md), the current
[workflow](../../../.github/workflows/ci.yml) and
[test profiles](../../../test/support/tagged/profiles.mjs) at the trusted base.
If they disagree, report the discrepancy and inspect implementation; do not
silently promote an issue proposal into active policy.

The current contract separates:

- PR L1 static/catalog/docs checks and L2 hermetic UT, ST and mocked E2E.
- L3 on the merge-group SHA: repeated applicable checks, short real journeys
  and distribution gates. A PR-head result cannot certify this different SHA.
- L4 daily and L5 release research evidence. L5 failure blocks Release/assets,
  not the already-created version tag. Do not move a tag to evade a failure.

The documented `merge-gate` and merge queue rely on actual repository settings.
Workflow YAML alone does not prove that required checks, stale-approval dismissal
or the queue are enabled. Report unverified settings as unknown. A maintainer's
review and enqueue decision is the current documented trust boundary; the queue
then merges after required gates without an invented second approval job.

Unlike a label-triggered CI design, the current PR workflow handles `opened`,
`synchronize` and `reopened`. After a fix commit, first locate its automatic run.
Do not toggle labels or start a duplicate run when the matching run is pending.
For missing/failed results, inspect the run and attempt before proposing the
smallest authorized rerun. Record its identity and follow it to a terminal
result or an actionable access/permission blocker. Do not repeatedly rerun the
same code failure without new evidence.

A repair request should include the failed job/case and log link, cause
(`code`, `infra` or `unknown`), fix commit, local command, OS/runtime/backend,
planned/executed/passed/failed/skipped counts, and relevant logs or screenshots.
Screenshots supplement reproducible commands and text; they do not independently
prove current-head CI or real-model acceptance. Lack of required hardware or
credentials is BLOCKED, not a local pass. Never request secrets in public logs.

For user-visible changes, require the goal-to-outcome browser/API/CLI/local-stack
journey specified by CONTRIBUTING. `pnpm ci:e2e` is the mocked browser subset,
not all possible acceptance. Check frozen plan, preflight and summary identity
and counts; exit code zero alone is insufficient. Skipped/quarantined cases are
not executed passes, and one backend's pass does not certify another backend.

## Evidence record and TODO template

Persist records only in the operator's approved state store. Use full SHAs and
UTC timestamps with a displayed timezone. Keep at least:

- Repository, issue/PR URL, stage, priority rationale and discovery query/pages.
- Current state/draft/base/head, fetched time and source links.
- Blocker category, first observed time (or unknown), evidence, release impact,
  verified owner, suggested next actor and event that warrants rechecking.
- Last successfully reviewed head, review scope, unresolved human concerns,
  completed review time, published review/comment identity and verified URL.
- Check run/attempt, exact SHA/profile/backend, conclusion and artifact counts;
  missing evidence and separately recorded real-acceptance result.
- Request deduplication identity, publication outcome, incomplete work and
  next check. Never overwrite successful review history with a failed attempt.

Use only applicable items; do not require contributors to solve maintainer-only
configuration or claim that all checks below were run:

```markdown
Current head: <full SHA>; evidence refreshed: <timestamp/timezone>
Stage / blocker: <node and concrete missing evidence>
Release impact: <confirmed/proposed/unknown, source>

Contributor
- [ ] Diagnose <failed job/case URL>; identify cause and fix commit.
- [ ] Supply <named local test> command, environment, result counts and logs/screenshots.

Reviewer
- [ ] Verify the fix and evidence against the current head.
- [ ] Resolve <linked concern/dependency/acceptance gap> with explicit evidence.

Maintainer / release owner
- [ ] Decide <specific dependency, missing access or necessary rerun>.
- [ ] Confirm applicable merge/release gates and record the authorized decision.

Next actor: <verified person or suggested role>
Recheck when: <head/run/evidence/decision changes>
Coverage: <what was read/run; what remains unknown>
```

Immediately before an authorized comment/review, read latest discussion and
current state/head. Reuse an existing equivalent request instead of adding noise.
If authorized to update a prior comment, edit only the operator's own comment;
otherwise report the change privately. No findings means no invented defect.

## Measuring whether the loop helps

Measure first actionable feedback, time waiting by blocker, first verified
readiness, review completion, enqueue, merge and acceptance separately. Use
actual event times; first observation is only an upper bound on readiness.
Compare like-for-like PR type/size/platform and disclose sample sizes and missing
timestamps. Track escaped regressions, stale-head decisions and repeated
no-change checks alongside throughput. Merge counts alone do not establish
review quality or causality. Keep triage, readiness recheck and deep review
counts separate; a retry is not a newly triaged PR.

## Dry-run acceptance scenarios

Before deployment, exercise this guide read-only against captured public-safe
fixtures and have a reviewer inspect the decisions. These are acceptance cases,
not a claim that an executable scheduler has been tested:

1. A failed page preserves incomplete discovery and backlog; it never reports
   an empty or fully covered queue.
2. An old PR with a new head re-enters source review. An unchanged head with a
   new CI attempt receives a readiness check without duplicating code review.
3. A head changes after review: publication waits for revalidation. A draft or
   closed PR cannot receive an approval based on the previous snapshot.
4. A human already requested the same repair evidence: no duplicate comment.
5. A screenshot says local pass but required journey identity/counts are absent:
   record the supplied evidence and the precise remaining gap, not "untested".
6. A matching run is pending: monitor it; do not retrigger. Code-failure repair
   without local evidence stays with the contributor; infra diagnosis does not
   turn the required check green.
7. PR L1/L2 passes but merge-group L3 is missing: PR checks are passed, merge
   readiness remains unverified. Distinguish not-yet-enqueued (L3 not yet due)
   from an expected merge-group run whose evidence is missing. Missing release
   acceptance remains distinct.
8. A publication response is lost: read back before retrying, preserving the
   completed review even while publication is uncertain.
