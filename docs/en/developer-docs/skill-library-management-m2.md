# Skill Library Management M2 delivery

M2 aims to move Skill Libraries from usable to practical: retrieval quality improves, conflicts
are easier to find, version quality becomes visible, and the older Skill-management entry
gradually moves to the library model.

## Problem to solve

After M1, the runtime can mount libraries and perform basic retrieval. String search is
not reliable enough for large libraries, conflicts are mostly structural, and users and
self-evolution views still lack a clear view of version quality.

M2 improves:

- retrieval quality;
- semantic-conflict diagnostics;
- version-evaluation visibility;
- migration from `/api/skills` and SkillManager.

## Deliverables

- Upgrade `/api/skill-libraries/search` from simple string retrieval to hybrid retrieval.
- Preserve evaluation-metric history for each library version.
- Add a semantic-conflict diagnostic result type.
- Let SkillManager handle libraries, versions, diffs, rollback, and evaluation summaries.
- Keep `/api/skills` compatible while gradually using the library model internally.

## Hybrid retrieval

Recommended retrieval signals include:

- exact `name` matches;
- `description` text matches;
- `domainTags` filtering and weighting;
- `triggers` matches;
- vector similarity;
- historical Skill hit rate or evaluation score.

The interface remains unchanged. Only internal ordering and index implementation change,
so application loops are unaffected.

## Conflict diagnostics

M2 can add `SkillConflictDiagnostic`:

```ts
interface SkillConflictDiagnostic {
  level: "warning" | "error";
  skillIds: string[];
  reason: string;
  evidence: string[];
}
```

The first version can emit only a warning and let a user or application layer decide
whether to block. Only structural conflicts remain mandatory framework blocks.

## Version-quality view

Every library version can show:

- version number, content hash, and creation time;
- the diff from its previous version;
- self-evolution evaluation metrics;
- improvement or regression relative to a baseline;
- a rollback entry;
- whether historical Prompt Manifests reference it.

## Acceptance criteria

- Search quality is clearly better than plain string matching.
- One query can rank tags, triggers, and vector results together.
- The UI can view version history, diffs, evaluation summaries, and rollback.
- Semantic conflicts can appear as warnings.
- The older Skill-management entry remains usable without breaking existing workflows.

## Not included yet

- Letting the framework decide directly whether self-evolution succeeded.
- Automatic deletion of historical Skill packages.
- A guarantee of zero false positives in semantic-conflict diagnostics. It is an aid, not
  the final decision.
