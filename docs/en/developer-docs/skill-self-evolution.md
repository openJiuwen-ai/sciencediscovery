# Skill self-evolution design

This document describes a reviewable, reversible self-evolution loop built on the existing
Skill Library and subagent framework. Here, “self-evolution” does not change base-model
parameters. After a task, an Agent can distil reusable experience into a Skill, then use Skill
Library versioning, retrieval, and distribution to manage it.

The existing Skill Library MVP/M1 provides most of the framework foundation:

- Skill libraries, library versions, batch commits, diffs, and rollback.
- Runtime mounting of one or more Skill Libraries.
- Pinning `head` to a concrete version when a run is created.
- Retrieval of top-N Skills from mounted libraries before the existing progressive disclosure.
- Prompt Manifest records of the library versions and Skill snapshots actually used.

The principal framework problem is therefore not multi-agent orchestration. It is making Skill
updates a **triggerable, reviewable, evaluable, and reversible** product loop.

At the current implementation state, the M1.5 foundation includes:

- Agents and subagents can call `propose_skill_library_update` to create a pending proposal.
- The tool accepts structured `upsert_skill` input and generates a valid `SKILL.md`, reducing
  YAML-frontmatter errors.
- The backend dry-runs a Skill Library proposal and returns its diff, diagnostics, and conflicts.
- Skill Manager can display pending proposals and diffs, and publish one or more proposals.
- An Agent can call `publish_skill_library_update`, but it must pass the existing permission
  confirmation flow.
- Several proposals produced by parallel subagents can be published together as one new Skill
  Library version.

## 1. Relationship to EvoSkill

EvoSkill's central idea is reusable:

```text
Run a task
  -> find failed examples
  -> a Proposer analyses the failure and proposes a create/edit Skill change
  -> a Skill Builder produces the Skill folder
  -> evaluate the candidate
  -> use it in later tasks if it passes
```

ScienceDiscovery does not need a separate multi-agent framework for this. Its existing subagents
can take these roles:

- The primary Agent or a reviewer finds failed examples.
- A `proposer` subagent analyses the trajectory and proposes a new or changed Skill.
- A `skill-builder` subagent creates a standard Skill package.
- The existing Skill Library Catalog performs dry-run, validation, diff, commit, and rollback.

EvoSkill's program branches and frontier need not be implemented initially. If parallel candidate
evolution becomes useful, it can map to several `SkillLibraryVersion` values rather than making
Git branches another source of truth.

## 2. Goals and non-goals

Goals:

- Let an Agent or subagent propose a Skill Library update.
- Dry-run every update and return its diff, diagnostics, and conflicts.
- Require user confirmation before publishing by default. An Agent may initiate publishing, but
  it must use permission confirmation.
- Let published Skills enter later runs through the M1 retrieval path rather than silently
  entering every context.
- Record the runs, artifacts, reviewer findings, or human feedback behind an update.

Non-goals:

- Do not add a separate multi-agent orchestration system; reuse subagents.
- Do not let an Agent silently commit a Skill Library.
- Do not implement a frontier, automatic publication policy, or complex benchmark scheduling in
  the first phase.
- Do not modify base-model weights.

## 3. Minimal loop

The first phase is a human-confirmed self-evolution loop:

```text
Run completes
  -> primary Agent / reviewer identifies a failure or reusable lesson
  -> start a proposer subagent to suggest a Skill update
  -> start a skill-builder subagent to create a Skill package
  -> Agent calls propose_skill_library_update to create a pending proposal
  -> backend dry-runs the Skill Library update
  -> UI shows the diff, diagnostics, and provenance
  -> user publishes, or the Agent calls publish_skill_library_update and awaits authorization
  -> later runs retrieve the new Skill from a mounted library
```

An Agent cannot publish silently. A real commit still requires either a manual publish in the UI
or a permitted `publish_skill_library_update` call.

## 4. Framework interfaces already added

The current API and Agent tool layer can write Skill Libraries:

- `POST /api/skill-libraries/:libraryId/versions`
- `POST /api/skill-libraries/:libraryId/proposals`
- `POST /api/skill-library-proposals/:proposalId/publish`
- `POST /api/skill-library-proposals/publish`
- `dryRun`
- `author.kind = "self-evolution"`
- diffs, diagnostics, conflicts, and rollback

Agent tools:

```text
propose_skill_library_update
publish_skill_library_update
```

`propose_skill_library_update`:

- Takes a target library, base version, update description, and Skill packages.
- Performs only a backend dry-run.
- Returns a diff, diagnostics, conflicts, and a pending proposal ID.
- Does not update `head` or publish a new version.

It can reuse the body of `CommitSkillLibraryVersionRequest`, but must enforce:

- `dryRun: true`
- `author.kind: "self-evolution"`
- source references such as a run, session, artifact, or reviewer finding
- no writes to read-only built-in libraries
- no overwrite of a library the user has not authorized

`publish_skill_library_update`:

- Takes one or more pending proposal IDs.
- Requires all proposals to belong to the same writable Skill Library.
- Merges them into one Skill Library commit.
- Requires permission confirmation before publishing and cannot run silently.
- Returns conflicts without moving `head` if publication fails.

## 5. Subagent roles

Self-evolution roles are prompts for subagents, not a new runtime abstraction.

### Proposer subagent

Responsibilities:

- Read a failed run's goal, trajectory, tool errors, reviewer findings, and final output.
- Decide whether the result truly warrants a Skill update.
- Decide whether to create a new Skill or edit an existing one.
- State a short rationale and applicability boundary.

It may return `create`, `edit`, or `no-op` when a Skill is the wrong way to retain the lesson.

### Skill-builder subagent

Responsibilities:

- Turn the proposal into a standard Skill package.
- Produce `SKILL.md`, description, triggers, and domain tags.
- Add `references/` or `scripts/` only when needed.
- Keep ground truth, private paths, tokens, and one-off sample content out of the Skill.

Its result goes through `propose_skill_library_update` and the existing backend validation.

## 6. What the UI needs to show

The UI need not become a separate self-evolution workbench. Skill Manager already shows pending
proposals and provides Reject, Publish, and Publish selected. The next step is to connect a
proposal more naturally to the run that created it in Session and Run views:

- Source run, session, artifact, or reviewer finding.
- Target library and base version.
- Skills added or changed.
- Skill Library diff.
- Diagnostics and conflicts.
- `Reject` and `Publish` actions.

Publishing creates a new `SkillLibraryVersion`; existing diff and rollback affordances remain
available.

## 7. Recommended next steps

M1.6 adds a run-level self-evolution entry point, so users can retain a Skill from a task result
without writing a prompt or remembering a tool name.

Current flow:

```text
Run completes
  -> user clicks “Summarize as Skill” on the completed Run
  -> backend starts a normal Agent run
  -> proposer subagent decides whether a Skill is warranted
  -> skill-builder subagent creates a structured upsert_skill
  -> primary Agent calls propose_skill_library_update
  -> UI shows the pending proposal in the current Session / Skill Manager
  -> user publishes selected proposals
```

M1.6 implementation items:

- Show “Summarize as Skill” only on the latest eligible completed, failed, or interrupted source
  Run. Before summarization begins, hide it when no writable Skill Library exists, the Session is
  archived, or no model is configured; existing summarization tasks and results remain visible.
- Queue a normal Agent run with a fixed M1.6 prompt for the proposer and skill-builder subagents.
- Recommend `project-skills` as the target library and give the self-evolution run every writable
  library so the model can choose a better match.
- Do not create the recommended library automatically; it can be created in Skill Library
  management settings.
- Require structured `upsert_skill` input in the fixed prompt to avoid hand-written `SKILL.md`.
- Require source references to the original session and run.
- Prevent a self-evolution run from becoming another self-evolution source.
- Publish in Skill Manager's pending-proposal area.
- Keep an outlined entry while no action is taken, a request is submitting, or the corresponding
  summary Run has not ended. Once that Run reaches a real terminal state, show an expandable grey
  result record. Submission acceptance is not completion; retain the in-progress display while a
  retry is submitting.
- Track `create_skill` drafts by exact draft ID. Opening or closing review does not count as
  review. Once the pending list confirms the draft disappeared, show “handled” rather than claim
  approval; a failed lookup must not turn it into completion. This draft path is separate from
  publishing a library-update proposal.

Further improvements:

- Proposal cards currently focus on diffs and rationale. Later they can present applicability
  boundaries, risk notes, and links to source runs more clearly.
- At least one writable Skill Library is currently needed. A future Project default or one-click
  `project-skills` creation could reduce that setup cost.
- After publishing, the current Session can explain that the new Skill takes effect in later runs
  through mounted-library retrieval.

After M1.6, M2 can assist publication with evaluation:

- Link a proposal to reviewer findings or lightweight replay results.
- Check whether a new Skill is too broad, leaks one-off samples, or includes private paths.
- Show a quality summary: recommend publish, recommend reject, or needs human revision.

## 8. Runtime boundary

Publishing a self-evolved Skill does not add it automatically to every Agent context. Runtime
behavior remains the M1 path:

1. A Project or Session mounts a Skill Library.
2. Run creation pins a concrete library version.
3. At run start, the runtime retrieves top-N Skills from mounted libraries.
4. Retrieved candidates are combined with manually selected Skills.
5. The Agent uses directory metadata in the Prompt and calls `read_skill` by exact ID for
   progressive disclosure.

Self-evolution changes library content. Library mounting, retrieval, and user settings still
govern whether an Agent can see it.

## 9. Safety principles

- An Agent may propose; publication requires user-confirmed permission.
- Dry-run every generated Skill update.
- Built-in libraries are read-only by default.
- Ground truth, reference answers, and hidden benchmark data may inform failure analysis but must
  not enter a Skill body.
- Every Skill must state its applicability boundary to avoid overly broad triggering.
- Publishing creates a new version and never rewrites history.
- Users can roll back an incorrect evolution.

## 10. Phased delivery

### M1.5: Agents can propose Skill updates (implemented)

- Add `propose_skill_library_update`.
- Let it call the Skill Library dry-run internally.
- Use existing subagents for proposer and skill-builder roles.
- Display pending proposals and diffs in the UI.
- Let users publish manually, or let an Agent request publication permission.
- Support publishing several pending proposals together.

### M1.6: Run-level self-evolution entry point (implemented)

- Provide a manual “Summarize as Skill” entry point in Run and Session views.
- Use existing subagents for proposer and skill-builder work.
- Return to the current Session after a pending proposal is created.
- Let the user publish selected proposals from that context.

### M2: Evaluation-assisted publication

- Link proposals to reviewer results or benchmark scores.
- Support baseline/candidate comparison.
- Show evaluation summaries on Skill Library versions.
- Keep human confirmation as the default.

### M3: Controlled automatic publication

- Enable policy-driven automatic publication only for low-risk new Skills.
- Keep edits to frequently used Skills, deletions, and evaluation rollback under human review.
- Adjust retrieval ordering using historical hit and failure rates.

## 11. Relationship to existing Skill Library documents

- `skill-library-management-mvp.md`: libraries can store, commit, and roll back Skills.
- `skill-library-management-m1.md`: runtimes can mount libraries and retrieve candidate Skills.
- `skill-library-management-m2.md`: retrieval quality, conflict diagnostics, and version-quality
  views.
- This document: the self-evolution loop, where Agents and subagents safely propose Skill Library
  updates and progressively bring them into review, publication, and evaluation.
