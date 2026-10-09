# Skill Library: Current Implementation

**Status: Current implementation**

This page documents the implementation that exists in the repository, not a roadmap. Sources of truth include:

- `services/api/src/skill-library-catalog.ts`
- `services/api/src/http/skill-libraries.ts`
- `packages/skill/`
- `packages/specialist/`
- Skill Library types in `@sciencediscovery/schema`

Historical MVP/M1/M2 delivery pages were removed so milestone goals are not mistaken for current behavior.

## 1. Boundary

Skill Library provides:

1. versioned grouping of multiple Skills;
2. immutable versions that freeze the Skill set used by a run;
3. search, diff, rollback, and conflict detection;
4. controlled proposals for Agent/self-evolution updates before publication.

It does not own the Agent loop or context assembly. Runtime Skill tools/context are composed through `packages/skill`, `packages/workspace`, and `packages/context`.

## 2. Main code

| Path | Responsibility |
| --- | --- |
| `services/api/src/skill-library-catalog.ts` | persistence and atomic mutation of libraries/versions/packages/proposals |
| `services/api/src/http/skill-libraries.ts` | Skill Library and proposal HTTP routes |
| `packages/skill/src/plugin.ts` | Skill runtime plugin: tools and context contribution |
| `packages/skill/src/manifest.ts` | plugin manifest and settings fields |
| `packages/specialist/src/skills.ts` | Skill package validation/runtime snapshots |
| `@sciencediscovery/schema` | shared Library/Version/Search/Proposal types |

## 3. Storage model

Default root:

```text
<data-dir>/skill-libraries/
├── catalog.json
├── packages/
│   └── sha256/<prefix>/<hash>/package/...
└── libraries/
    └── <library-id>/
        └── versions/
            └── <version-id>.json
```

### Library

`catalog.json` stores library metadata and the proposal index. `headVersionId` points at the current head.

### Version

Each publication creates an immutable `SkillLibraryVersion` containing author, base/parent version, Skills, content hash, evaluation metadata, and rollback source when applicable.

### Package

Skill packages are content-addressed by hash. After writing, the implementation reruns `validateSkillPackage` and verifies the stored hash; incomplete/invalid content is removed.

## 4. Commit and concurrency semantics

`SkillLibraryCatalog` serializes mutations with an in-process mutation queue.

A version commit:

1. validates library existence;
2. requires `baseVersionId` to match current head;
3. validates every upsert package;
4. detects duplicate edits and deleting missing Skills;
5. computes diff and version content hash;
6. does not publish on dry-run or conflict;
7. persists missing packages;
8. writes the immutable version file;
9. updates catalog head last.

A stale base therefore cannot silently overwrite a newer head.

## 5. Built-in library

At startup, `seedBuiltInSkillLibrary(repositoryRoot)` synchronizes `BUNDLED_SKILL_IDS` from repository `skills/` into the built-in library.

The built-in library is system-seeded, removes no-longer-bundled Skills from its next version, and rejects self-evolution proposals.

## 6. Runtime mount and freezing

Runtime settings use `enabledSkillLibraries`.

`resolveEnabledRefs()` resolves `head` at run start to concrete `versionId` and `contentHash`, deduplicates library/version pairs, and returns `PromptSkillLibraryRef`.

A run therefore uses a fixed version and is not affected by later head changes.

Relevant Skill plugin settings:

- `enabledSkillIds`
- `enabledSkillLibraries`
- `skillSelectionMode`

## 7. Current search implementation

Endpoint:

```http
POST /api/skill-libraries/search
```

Search is currently **deterministic lexical scoring**, not vector/model retrieval.

Rules include exact/id substring/description/token matches. Only positive-score candidates survive.

Across multiple libraries:

- higher priority wins;
- same Skill id at the same priority with different hashes yields `DUPLICATE_SKILL_PRIORITY_CONFLICT`;
- response includes frozen library refs, candidates, and conflicts.

Do not assume vector or hybrid retrieval exists.

## 8. Proposal / self-evolution path

Agent/self-evolution may create `SkillLibraryUpdateProposal` instead of mutating head directly.

A proposal requires rationale and sourceRefs and stores a dry-run commit result with diff/conflicts/diagnostics.

Pending proposals may be rejected, published individually, or batch-published when they belong to the same library.

Publication rebuilds the commit against the **current head**, so conflicts are rechecked if head changed after proposal creation.

The built-in library rejects self-evolution proposals.

## 9. HTTP API

```text
GET/POST  /api/skill-libraries
POST      /api/skill-libraries/search
GET       /api/skill-libraries/:id
GET/POST  /api/skill-libraries/:id/versions
GET       /api/skill-libraries/:id/versions/:version
GET       /api/skill-libraries/:id/versions/:from/diff/:to
POST      /api/skill-libraries/:id/rollback
POST      /api/skill-libraries/:id/proposals

GET       /api/skill-library-proposals
POST      /api/skill-library-proposals/:id/publish
POST      /api/skill-library-proposals/:id/reject
POST      /api/skill-library-proposals/publish
```

Use schema and route handlers as the exact request/response authority.

## 10. When modifying this subsystem

Check:

- package validation remains single-sourced;
- head updates only after package/version persistence;
- stale-base and duplicate-operation conflict semantics;
- built-in proposal read-only rule;
- runtime freezing to concrete version/content hash;
- Skill plugin context/tool behavior remains aligned with selection;
- API/UI changes include tests.

## Related docs

- [Skill progressive disclosure](skill-progressive-disclosure.md)
- [Skill self-evolution](skill-self-evolution.md)
- [Plugin architecture](plugins.md)
- [Dynamic context assembly](context-assembly.md)
