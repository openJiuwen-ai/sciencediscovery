# Preliminary Skill Library management design

This document addresses the framework requirement in
[GitCode Issue #116](https://gitcode.com/mindspore/ScienceAgent/issues/116): make Skill Libraries
versionable resources that can be created, searched, mounted, and rolled back, with an
application-facing interface for atomically writing Skill results from a self-evolution loop.

Progressive disclosure itself is outside this design. The frozen-snapshot behavior of
`read_skill` and `read_skill_resource` remains; this design supplies the preceding
library-level management, directory-level retrieval, and run-snapshot selection.

## 1. Background and current state

The repository already manages individual Skills and their runtime snapshots:

- `SkillCatalog` in `services/api/src/skills.ts` can import, create, update, and delete managed
  Skills, retaining an increasing revision for each.
- `validateSkillPackage` validates the Science Skills package form: root `SKILL.md`, YAML
  frontmatter, and optional `assets/`, `references/`, and `scripts/` resources.
- `SkillCatalog.resolve(ids)` copies current content into a `RuntimeSkillSnapshot`; a run reads
  that frozen snapshot.
- `buildSkillSystemSection` in `packages/agent-runtime/src/runtime.ts` puts metadata only for
  selected Skills into the system prompt, reading full content on demand.
- `services/api/src/prompt-manifest.ts` records used `skillRefs` as `id/hash/version/revision`.

Gaps:

- The resource model is still a global Skill directory plus individual revisions, not a
  first-class Skill Library.
- A revision expresses one Skill update rather than an atomic batch edit with library-level diff
  and rollback.
- Runtime settings provide only `enabledSkillIds` and `skillSelectionMode`, not mounted library
  versions or priority among several libraries.
- As Skills grow, manually choosing Skills and putting all metadata in a prompt will not scale.
- The application self-evolution loop lacks a stable write-back interface and must simulate a
  user calling individual Skill-edit APIs.

## 2. Goals and non-goals

Goals:

- Introduce `SkillLibrary` as a framework resource and allow several libraries.
- Make library versions immutable. Each commit creates a new version identified by content hash
  and version ID, and any historical version can be rolled back to.
- Atomically apply batch create, update, and delete operations.
- Diff versions by added, removed, and changed Skills.
- Let a run mount one or more concrete library versions and record library versions plus final
  Skill snapshots in Prompt Manifest.
- Retrieve candidate Skills from a whole library or a selected version for a task query, before
  existing progressive disclosure.
- Accept candidate Skill edits, evaluation summaries, and artifact references from an
  self-evolution loop, validate them, and create a new library version.

Non-goals:

- The framework does not design scoring, generator/judge coordination, audit sampling, gated
  rollback, significance tests, resumability, or cost accounting for the self-evolution loop.
- It does not redesign the `read_skill` progressive-disclosure protocol.
- It does not introduce a ScienceAgent-only Skill DSL. Outputs stay compatible with Agent Skills
  and Science Skills packages.
- The first phase detects but does not automatically resolve high-level semantic conflicts.

## 3. Core concepts

### SkillPackage

A single package keeps the existing shape:

```text
<skill-id>/
  SKILL.md
  references/*
  scripts/*
  assets/*
```

At minimum, `SKILL.md` frontmatter contains:

```yaml
---
name: antibody-protenix-pipeline
description: Run the governed antibody design pipeline.
metadata:
  version: 1.0.0
  domain-tags: antibody, protein-design
  triggers: antibody design tasks requiring RFdiffusion or Protenix validation
---
```

The library layer normalizes and indexes these fields:

- `id/name`: stable identity using the existing lowercase-letter, number, single-hyphen rule.
- `description`: primary directory-retrieval field.
- `domainTags` and `triggers`: normalized from the corresponding metadata fields or later explicit
  frontmatter fields.
- `instructions`: the `SKILL.md` body.
- `resources`: existing resource summaries and hashes.
- `packageHash`: the existing `packageHash(files)` definition.

### SkillLibrary

A named collection points to a head version rather than storing content directly:

```ts
interface SkillLibrary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  headVersionId: string;
  defaultMountPriority: number;
  readOnly: boolean;
}
```

Built-in Skills should belong to a read-only `builtin` library, while user and self-evolution
outputs go to managed libraries. This lets existing built-in and managed Skills share mounting,
priority, and retrieval behavior.

### SkillLibraryVersion

An immutable snapshot records all Skill references in that version:

```ts
interface SkillLibraryVersion {
  id: string;
  libraryId: string;
  sequence: number;
  parentVersionId?: string;
  createdAt: string;
  createdBy: SkillLibraryCommitAuthor;
  message: string;
  contentHash: string;
  skills: SkillLibrarySkillRef[];
  evaluation?: SkillLibraryEvaluationSummary;
}
```

Each `SkillLibrarySkillRef` includes identity, name, description, domain tags, triggers, version,
package hash and reference, resources, and validation diagnostics. `contentHash` is calculated by
stably serializing Skills sorted by ID. Equal library content has an equal hash; the version ID may
be `libv_<sequence>_<hash-prefix>` or a UUID, and the API returns both.

```ts
interface SkillLibrarySkillRef {
  id: string;
  name: string;
  description: string;
  domainTags: string[];
  triggers: string[];
  version: string;
  packageHash: string;
  packageRef: string;
  resources: SkillResource[];
  diagnostics: SkillValidationDiagnostic[];
}
```

### SkillLibraryCommit

A commit applies edits to a base version:

```ts
interface CommitSkillLibraryVersionRequest {
  baseVersionId: string;
  message: string;
  author: SkillLibraryCommitAuthor;
  operations: SkillLibraryOperation[];
  evaluation?: SkillLibraryEvaluationSummary;
  dryRun?: boolean;
}

type SkillLibraryOperation =
  | { op: "upsert"; skillId: string; package: SkillPackageInput; expectedPackageHash?: string }
  | { op: "delete"; skillId: string; expectedPackageHash?: string };
```

`expectedPackageHash` supplies optimistic concurrency control. A loop editing a Skill against a
known version can state the hash it expects; a changed base returns `409` instead of silently
overwriting it.

`SkillPackageInput` has three forms:

```ts
type SkillPackageInput =
  | { kind: "inline"; skillMarkdown: string; resources?: Array<{ path: string; contentBase64: string }> }
  | { kind: "artifact"; artifactId: string; artifactVersionId?: string; subdirectory?: string }
  | { kind: "session-workspace"; sessionId: string; path: string };
```

- `inline` suits a small `SKILL.md` and a few resources generated directly by a loop.
- `artifact` reads a selected Project Artifact/CAS version, such as an archived Skill-package ZIP
  or directory.
- `session-workspace` suits a package just generated in one Session workspace. The server must use
  the existing workspace-path resolver to verify that the path stays inside that Session.

Every source is normalized to `Map<path, Buffer>` and passed to `validateSkillPackage`; callers'
names, hashes, and resource summaries are not trusted.

## 4. Storage design

Add library-level storage without changing the existing `data/skills` layout:

```text
<data-dir>/skill-libraries/
  catalog.json
  packages/sha256/<package-hash>/package/...
  packages/sha256/<package-hash>/package.json
  libraries/<library-id>/library.json
  libraries/<library-id>/versions/<version-id>/manifest.json
  libraries/<library-id>/head
  libraries/<library-id>/.staging/*
```

- Packages are content-addressed: write staging, validate the hash, atomically rename, and reuse
  identical packages.
- A version `manifest.json` is the source of truth for that complete library snapshot.
- `head` or `library.json.headVersionId` identifies the default version. Initially, rollback should
  create a new rollback commit, retaining a linear audit trail.
- A commit builds its manifest, writes missing packages, validates and detects conflicts, atomically
  publishes the manifest, then moves `head`.
- Reuse `SkillCatalog` validation and mutation-queue ideas, serializing commits per `libraryId`.

For migration, retain `/api/skills` as a compatibility view over `builtin + default managed
library head`. Existing managed Skills may lazily migrate to `managed-default`, and a new
`SkillLibraryCatalog` may initially wrap `SkillCatalog` before storage is consolidated.

## 5. API design

Library management includes:

| Method and path | Purpose |
|---|---|
| `GET /api/skill-libraries` | List libraries and head summaries |
| `POST /api/skill-libraries` | Create an empty library and its initial empty version |
| `GET/PATCH /api/skill-libraries/:libraryId` | Read or update library metadata and priority |
| `GET /api/skill-libraries/:libraryId/versions` | List version history |
| `GET /api/skill-libraries/:libraryId/versions/:versionId` | Read a version manifest |
| `POST /api/skill-libraries/:libraryId/versions` | Commit edits from a base version |
| `POST /api/skill-libraries/:libraryId/rollback` | Create a rollback commit from history |
| `GET /api/skill-libraries/:libraryId/diff?base=&head=` | Diff two versions |

A successful `POST /versions` returns the library and version IDs, sequence, content hash, added,
modified, and deleted lists, plus diagnostics. With `dryRun: true`, it returns only diff,
diagnostics, and conflicts and publishes nothing.

```json
{
  "libraryId": "managed-default",
  "versionId": "libv_42_ab12cd34",
  "sequence": 42,
  "contentHash": "ab12cd34...",
  "diff": {
    "added": ["foo-skill"],
    "modified": ["bar-skill"],
    "deleted": []
  },
  "diagnostics": []
}
```

### Directory-level retrieval

```http
POST /api/skill-libraries/search
```

The request supplies a query, library/version/priority mounts, an optional limit, and filters such
as `domainTags`. The response returns only candidate metadata suitable for the existing
progressive-disclosure flow: library/version, Skill ID, description, domain tags, triggers,
score, and package hash. The first phase uses deterministic name/description token scoring and
may add tags and triggers. Its stable interface can later use vector or hybrid retrieval; after a
candidate is made a runtime snapshot, no extra regular-expression matching occurs.

```json
{
  "query": "design antibody candidates and validate structures",
  "libraries": [
    { "libraryId": "builtin", "versionId": "head", "priority": 0 },
    { "libraryId": "evolved-antibody", "versionId": "libv_12_...", "priority": 10 }
  ],
  "limit": 20,
  "filters": { "domainTags": ["antibody"] }
}
```

The response's `candidates` array contains each candidate's `libraryId`, `versionId`, `skillId`,
`description`, `domainTags`, `triggers`, `score`, and `packageHash`.

### Self-evolution write-back

The application loop should use only:

```http
POST /api/skill-libraries/:libraryId/versions
```

`author.kind` distinguishes users from a self-evolution run with project, session, run, or job
identity. An optional evaluation summary can contain dataset, test accuracy, pass rate, baseline
version, typed metric summary, artifact references, and notes. The framework validates JSON,
package form, size, path safety, and UTF-8; validates the base; applies all operations; computes
diff and hashes; detects basic conflicts; and atomically publishes only outside dry-run. The
application decides when to commit or roll back and how to interpret metrics and conflicts.

## 6. Runtime mounting and snapshots

Runtime settings add library mounts while retaining `enabledSkillIds` compatibility:

```ts
interface RuntimeSkillLibraryMount {
  libraryId: string;
  versionId?: string; // omitted means resolve head at run creation
  priority: number;
}

interface RuntimeSettingsOverrides {
  enabledSkillLibraries?: RuntimeSkillLibraryMount[];
  enabledSkillIds?: string[]; // legacy compatibility
  skillSelectionMode?: "all" | "selected";
}
```

Resolution:

1. Read effective Project and Session settings when creating a run.
2. Resolve every `head` to a concrete version ID and content hash in `settingsSnapshot`.
3. Merge library versions from highest to lowest priority.
4. For equal Skill names, use the highest priority version. Equal priority with different package
   hashes is a conflict requiring an explicit priority choice.
5. Apply any `enabledSkillIds` allowlist to the merged view.
6. Retrieve directory candidates and create the Skills exposed through progressive disclosure.

Prompt Manifest retains final `skillRefs` for compatibility and adds `skillLibraryRefs` with the
library ID, concrete version ID, content hash, and priority. Evaluation runs must pin a version,
not float on `head`, so library changes cannot contaminate metrics.

## 7. Diff, rollback, and conflict detection

A diff labels Skill IDs as `added`, `deleted`, `modified` when package hashes differ, or
`unchanged` when they match. Rollback takes a target and current base version, creates new content
from the target manifest, and commits it from current head. History remains append-only and every
version cited by Prompt Manifest remains reproducible.

Structural conflicts block commit or runtime: duplicate upserts in one commit, deletion of a
missing Skill, mismatched expected hash, and equal-priority same-name packages with different
hashes. Semantic conflicts, such as highly overlapping tags/triggers with clearly contrary
instructions, initially return warnings only; a later application auditor may produce
`SkillConflictDiagnostic`.

## 8. Code locations

- `packages/schema/src/skill-libraries.ts`: shared library, version, commit, diff, and search types.
- `services/api/src/skill-libraries.ts`: `SkillLibraryCatalog`, reusing package validation and hash.
- `services/api/src/http/index.ts`: `/api/skill-libraries*` routes.
- `services/api/src/runs/index.ts`: pin library mounts and choose a run's Skill snapshots.
- `packages/schema/src/runtime-settings.ts`: `enabledSkillLibraries` with legacy IDs retained.
- `packages/schema/src/provenance.ts` and `services/api/src/prompt-manifest.ts`: library refs.
- `apps/web/src/api/skills.ts`: client support for library, version, diff, and rollback UI.

The first phase need not change `read_skill`. It changes the collection passed to agent runtime:
that collection comes from pinned library versions and directory retrieval instead of every current
`enabledSkillIds` entry.

## 9. Phased delivery

- [MVP: Skill Library versions and self-evolution write-back](skill-library-management-mvp.md)
- [M1: Runtime mounting and directory-level retrieval](skill-library-management-m1.md)
- [M2: Hybrid retrieval, conflict diagnostics, and UI migration](skill-library-management-m2.md)

MVP makes libraries committable, reversible, and auditable. M1 mounts pinned versions and exposes
only retrieved candidates. M2 improves retrieval quality, conflict diagnostics, and user-facing
management.

## 10. Key constraints

- Every run, evaluation, and audit must bind concrete library versions and package hashes.
- A self-evolution loop changes a library only by committing a new version, never an active folder.
- Skill packages remain portable; a ScienceAgent library manifest is a management index, not a
  runtime format.
- Write-back revalidates package, path, size, and hash rather than trusting application output.
- Versions are immutable. A future garbage collector may clean only packages unreferenced by
  Prompt Manifest, Artifacts, or version manifests.
