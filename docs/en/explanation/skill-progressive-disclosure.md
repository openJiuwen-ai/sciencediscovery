# Skill Progressive Disclosure

This page explains how a model discovers, reads, and audits Agent Skills during a run. It follows a catalog-first pattern and retains ScienceDiscovery's frozen-snapshot semantics.

## Design goals

- Keep the system prompt light: list selected skill name, description, version, revision, and resource count, not full `SKILL.md`.
- Load instructions on demand through `describe_skill` and then `read_skill`.
- Freeze selected revision, package hash, instructions, and resources at run start, so later reads cannot observe a disk edit.
- Separate discovery from content: `describe_skill` searches the catalog and returns metadata only, while `read_skill` returns content from the frozen snapshot.

## Runtime flow

```text
effective Session skills → API frozen revisions
  ├─ prompt: metadata only
  └─ tool table: describe_skill / read_skill / read_skill_resource
       ↓
describe_skill(query) → catalog search over this run's skills
       ↓
read_skill(skillId) → frozen instructions
       ↓
read_skill_resource(skillId,path) → referenced supporting text only
```

## Tool responsibilities

| Tool | Location | Responsibility |
|---|---|---|
| `describe_skill` | Node workspace tool | Search name/description and return metadata, revision, hash, and resource summary |
| `read_skill` | Node workspace tool | Return full instructions and supporting-resource list from the run snapshot |
| `read_skill_resource` | Node workspace tool | Read bounded UTF-8 snapshot resource; never execute scripts or install dependencies |

All three come from `createWorkspaceTools` in `packages/agent-runtime` and are invoked in-process by the Node-native loop like any other workspace tool.

## Why not hand the model a file path?

A common alternative is to expose the `SKILL.md` filesystem location and let the model open it with a generic read tool. ScienceDiscovery records a fixed revision and package hash in the Prompt Manifest, and reading a live path mid-run could observe a later edit and break reproducibility. Content therefore comes back through the typed `read_skill` tool, backed by the frozen snapshot.

## Security boundary

- Skill entries injected into the prompt contain metadata, not content.
- `read_skill.skillId` is an enum of skills selected for the run.
- Resource paths are restricted to snapshot text resources.
- `scripts/` are retained in packages but never auto-executed, installed, or copied into Python workspaces.
- Revision, version, and package hash enter Prompt Manifest.

## Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Runtime behavior](../reference/runtime-behavior.md)
