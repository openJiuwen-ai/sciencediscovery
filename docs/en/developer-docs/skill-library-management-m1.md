# Skill Library Management M1 delivery

M1 aims to bring Skill Libraries into the runtime so a task can mount one or more library versions
and automatically select candidate Skills for that task.

## Problem to solve

The MVP makes libraries committable and reversible. If runtime use still depends on users
checking Skills one by one, a large library remains impractical.

M1 adds:

- selecting library versions at runtime;
- mounting multiple libraries together;
- priority-based merging of same-named Skills;
- catalog-level retrieval from mounted libraries;
- freezing library versions when a run starts so evaluation is not affected by an evolving
  `head`.

## Deliverables

- Add `enabledSkillLibraries` to runtime settings.
- Resolve `head` to a concrete `versionId + contentHash` when a run is created.
- Support priority among multiple mounted libraries.
- Support same-name de-duplication and structural-conflict blocking.
- Add `/api/skill-libraries/search`.
- Pass only retrieved candidate Skills into the existing progressive-disclosure flow.

## Runtime resolution flow

1. Read effective Project and Session settings.
2. Resolve each mounted Skill Library.
3. If the user selected `head`, immediately freeze it to a concrete version.
4. Merge Skills from highest to lowest priority.
5. Retain the highest-priority version of a same-named Skill.
6. If same-named Skills at the same priority have different hashes, block the run and
   return a conflict.
7. Retrieve candidate Skills from the merged library view with the task query.
8. Resolve candidates to frozen snapshots. Catalog metadata enters the Prompt, while
   `read_skill` reads the body by exact ID.

## Core interface

```http
POST /api/skill-libraries/search
```

The request contains:

- `query`: a user task or retrieval text constructed by the application layer.
- `libraries`: library versions to search and their priorities.
- `limit`: the number of candidates to return.
- `filters`: filters such as domain tags.

The response returns candidate Skill metadata, not complete `SKILL.md` bodies.

## Acceptance criteria

- A Session can mount multiple Skill Libraries.
- A floating `head` is frozen to a concrete version when a run is created.
- Prompt Manifest records the resulting `skillLibraryRefs` in the run.
- Same-named Skills merge consistently by priority.
- Same-priority conflicts block the run.
- With large libraries, the system prompt contains retrieved candidates rather than all
  library metadata.

## Not included yet

- Complex vector indexes. The first version may retrieve by strings, tags, or triggers.
- Changes to the complete-body `read_skill` protocol.
- Model-based semantic-conflict auditing.
