# Skill Library Management MVP delivery

The MVP goal is to make Skill Libraries manageable by the framework and let an application
loop write Skill outputs back. This stage does not require automatic runtime retrieval or
a complete UI migration.

## Problem to solve

At present, only individual Skills can be managed. When a self-evolution loop produces a
batch of Skills, it can only imitate individual user edits. It cannot express the batch as
an atomic commit from one evaluation or conveniently roll it back.

The MVP makes a Skill Library a versioned resource:

- A library contains multiple Skills.
- Every commit creates an immutable library version.
- A batch of Skill edits either all succeeds or all fails.
- A self-evolution loop can commit its output through one write-back interface.

## Deliverables

- Add `SkillLibraryCatalog` to store libraries, versions, and Skill packages.
- Add shared schemas: `SkillLibrary`, `SkillLibraryVersion`,
  `CommitSkillLibraryVersionRequest`, and `SkillLibraryDiff`.
- Add the `/api/skill-libraries` endpoints.
- Support batch `upsert`/`delete` through
  `POST /api/skill-libraries/:libraryId/versions`.
- Support `dryRun`, returning a diff, diagnostics, and conflicts before publishing.
- Support version diffs and rollback.
- Add `skillLibraryRefs` to Prompt Manifest to record the origin of library versions.

## Core interface

```http
POST /api/skill-libraries/:libraryId/versions
```

The request contains:

- `baseVersionId`: the library version on which this commit is based.
- `operations`: the Skills added, updated, or deleted in this commit.
- `author`: whether the source is a user or the self-evolution loop.
- `evaluation`: an evaluation summary supplied by the application layer. The framework
  stores it but does not interpret its metrics.
- `dryRun`: validate only; do not publish a version.

On success, it returns:

- the new version ID;
- the library-content hash;
- this commit's diff;
- validation diagnostics.

## Storage requirements

- Store Skill packages by content hash and reuse duplicate packages.
- Keep library-version manifests immutable.
- Update `head` only after its version manifest is written successfully.
- Prefer creating a new rollback version to rewriting history.

## Acceptance criteria

- A Skill Library can be created.
- A batch of Skill packages can be committed as a new version.
- If any package fails validation, the complete batch has no effect.
- Additions, deletions, and changes between two versions can be viewed.
- An earlier version can be restored.
- Prompt Manifest records library-version references used by a run.

## Not included yet

- Runtime automatic Skill retrieval.
- Vector retrieval.
- A complete SkillManager UI migration.
- Automatic semantic-conflict decisions.
