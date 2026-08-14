# Skill Progressive Disclosure

This page explains how a model discovers, reads, and audits Agent Skills during a run. It follows DeerFlow's catalog-first pattern while retaining ScienceDiscovery's frozen-snapshot semantics.

## Design goals

- Keep the system prompt light: list selected skill name, description, version, revision, and resource count, not full `SKILL.md`.
- Load instructions on demand through `describe_skill` and then `read_skill`.
- Freeze selected revision, package hash, instructions, and resources at run start, so later reads cannot observe a disk edit.
- Reuse DeerFlow `SkillCatalog.search(...)` for discovery while ScienceDiscovery's typed tool returns content.

## Runtime flow

```text
effective Session skills → API frozen revisions
  ├─ prompt and gateway skills[]: metadata only
  └─ Node: real read_skill/read_skill_resource
       ↓
Gateway describe_skill → DeerFlow catalog search
       ↓
read_skill(skillId) → frozen instructions
       ↓
read_skill_resource(skillId,path) → referenced supporting text only
```

## Tool responsibilities

| Tool | Location | Responsibility |
|---|---|---|
| `describe_skill` | gateway native | Search name/description and return metadata, revision, hash, and resource summary |
| `read_skill` | Node proxy | Return full instructions and supporting-resource list from the run snapshot |
| `read_skill_resource` | Node proxy | Read bounded UTF-8 snapshot resource; never execute scripts or install dependencies |

## Why not reuse DeerFlow's content-read path?

DeerFlow can expose a filesystem location for later reading, which fits its sandbox and directory model. ScienceDiscovery records a fixed revision and package hash in Prompt Manifest. Reading a live path mid-run could observe a later edit and break reproducibility. It therefore reuses catalog search but returns content through typed tools backed by the frozen snapshot.

## Security boundary

- Gateway `skills[]` contains metadata, not content.
- `read_skill.skillId` is an enum of skills selected for the run.
- Resource paths are restricted to snapshot text resources.
- `scripts/` are retained in packages but never auto-executed, installed, or copied into Python workspaces.
- Revision, version, and package hash enter Prompt Manifest.

## Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Runtime behavior](../reference/runtime-behavior.md)
