# Skill Self-Evolution: Current Implementation

**Status: Current implementation**

This page describes the current Skill self-evolution path. It is not background learning that automatically rewrites bundled Skills, and task completion does not automatically publish a new Skill.

The current mechanism is a controlled **proposal → user authorization → new-version publication** flow.

## 1. Goal

Self-evolution can preserve a reusable method from task experience while keeping:

- user visibility;
- writes limited to writable Skill Libraries;
- inspectable proposals before publication;
- current-head conflict checks at publication time;
- frozen Skill versions inside an active run;
- bundled Skills protected from Agent overwrite.

## 2. Two related paths

### Reviewable Skill draft

An explicit request or existing Session can produce a reviewable Skill draft. A draft remains inactive until reviewed/confirmed as a managed Skill.

Relevant implementation is primarily under:

- `packages/specialist/src/skills.ts`
- API Skill draft/import routes
- SkillManager UI

This path creates a reviewable Skill.

### Skill Library self-evolution proposal

An Agent may propose a library update through:

```text
propose_skill_library_update
```

This creates a pending proposal; it does not change library head.

After publication is authorized, the Agent/flow may call:

```text
publish_skill_library_update
```

One or more proposals for the same library are merged into one new Library version.

## 3. Proposal data flow

```text
Agent run
   │
   ├─ inspect existing Skill / task evidence
   ▼
propose_skill_library_update
   ▼
SkillLibraryCatalog.proposeUpdate()
   ├─ require rationale
   ├─ require sourceRefs
   ├─ force author.kind = self-evolution
   ├─ dry-run commit
   └─ persist pending proposal
              │
              │ user/permission allows publication
              ▼
publish_skill_library_update
              ▼
SkillLibraryCatalog.publishProposal(s)
   ├─ rebuild against current head
   ├─ validate packages
   ├─ detect conflicts
   ├─ persist packages/version
   └─ advance head
```

A proposal stores suggested changes, sources, and dry-run results; it is not an active Skill version.

## 4. Why publication rebuilds the commit

Library head may change after proposal creation.

Publication therefore reads current head, merges proposal operations again, reruns validation/conflict detection, and creates a new version only if valid.

This prevents an old proposal from silently overwriting newer changes.

## 5. Built-in Library is read-only for self-evolution

`BUILT_IN_SKILL_LIBRARY_ID` is system-seeded from repository `skills/`.

Self-evolution proposals cannot target the built-in library.

Evolving Skills belong in writable libraries. Updating bundled capabilities remains a source/release operation.

## 6. Active Runs are not polluted by a new head

At run start, `enabledSkillLibraries` head references resolve to concrete:

- `libraryId`
- `versionId`
- `contentHash`

Publishing a proposal therefore does not change the Skill set of an already-running task. New versions affect later runs that resolve the library again.

## 7. Tool exposure

`packages/skill/src/plugin.ts` builds Skill tools from host-provided ports.

Self-evolution tools appear only when the host supplies:

- `proposeSkillLibraryUpdate`
- `publishSkillLibraryUpdate`

Do not assume every Agent, Reviewer, or Specialist automatically has publication capability.

## 8. Permission and human control

Publication changes persistent capability state and must remain inside product permission/user-intent boundaries.

Principles:

- Agent may propose;
- proposal is inspectable;
- user controls publication authorization;
- publication creates a new version instead of rewriting history;
- conflicts are explicit rather than last-writer-wins.

## 9. What self-evolution does not mean

It is not:

- model-weight training;
- automatic online learning;
- automatic Skill creation after every task;
- unconditional publication based on an evaluation score;
- automatic modification of bundled Skills;
- proof that vector/model Skill Library retrieval exists.

See [Skill Library current implementation](skill-library-management.md) for the current retrieval implementation.

## 10. Change checklist

Inspect:

- proposal/publish tool schemas in `packages/workspace`;
- tool exposure in `packages/skill`;
- proposal/publication semantics in `skill-library-catalog.ts`;
- HTTP proposal APIs;
- permission/audit;
- runtime Skill-version freezing;
- UI review/publication path;
- tests and user journeys.

## Related docs

- [Skill Library current implementation](skill-library-management.md)
- [Skill progressive disclosure](skill-progressive-disclosure.md)
- [Plugin architecture](plugins.md)
