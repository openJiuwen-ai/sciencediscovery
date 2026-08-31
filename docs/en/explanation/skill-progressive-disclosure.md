# Skill Progressive Disclosure

This page explains how a model discovers, reads, and audits Agent Skills during a run. It follows a catalog-first pattern and retains ScienceDiscovery's frozen-snapshot semantics.

## Design goals

- Keep the system prompt light: list selected skill name, description, version, revision, and resource count, not full `SKILL.md`.
- Load instructions on demand by passing an exact catalog id to `read_skill`.
- Freeze selected revision, package hash, instructions, and resources at run start, so later reads cannot observe a disk edit.
- Separate discovery from content: the prompt contains catalog metadata, while `read_skill` returns content from the frozen snapshot.
- Materialize bundled executable resources explicitly into the Session workspace without returning their bytes to the model.

## Runtime flow

```text
effective Session skills → API frozen revisions
  ├─ prompt: metadata only
  └─ tool table: read_skill / read_skill_resource / materialize_skill_resource
       ↓
read_skill(skillId) → frozen instructions
       ├─ read_skill_resource(skillId,path) → referenced supporting text only
       └─ materialize_skill_resource(skillId,path,dest?) → frozen bytes in the writable workspace; metadata-only result
              ↓
          execute the returned workspace path with explicit argv through an existing execution tool
```

## Tool responsibilities

| Tool | Location | Responsibility |
|---|---|---|
| `read_skill` | Node workspace tool | Return full instructions and supporting-resource list from the run snapshot |
| `read_skill_resource` | Node workspace tool | Read bounded UTF-8 snapshot resource; never execute scripts or install dependencies |
| `materialize_skill_resource` | Node workspace tool | Copy exact snapshot bytes to a workspace-relative destination and return only destination, byte count, hash, skill id, revision, and overwrite status; never execute or install the file |

All three come from `createWorkspaceTools` in `packages/workspace` and are invoked in-process by the Node-native loop like any other workspace tool.

## Why not hand the model a file path?

A common alternative is to expose the `SKILL.md` filesystem location and let the model open it with a generic read tool. ScienceDiscovery records a fixed revision and package hash in the Prompt Manifest, and reading a live path mid-run could observe a later edit and break reproducibility. Content therefore comes back through the typed `read_skill` tool, backed by the frozen snapshot.

## Security boundary

- Skill entries injected into the prompt contain metadata, not content.
- `read_skill.skillId` is an enum of skills selected for the run.
- Read and materialize paths are restricted to resources in the selected frozen snapshot; materialize destinations must stay inside the current writable workspace.
- `scripts/` are retained in packages but never auto-executed, installed, or copied into workspaces merely because a Skill is selected. A loaded Skill may explicitly materialize one referenced script and then execute the returned workspace path.
- Materialization returns metadata only. Large or binary resource bytes go directly from the frozen snapshot to disk and are not placed in model context; do not search the filesystem for package resources or read a materialized large script back into context.
- Revision, version, and package hash enter Prompt Manifest.

## Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Runtime behavior](../reference/runtime-behavior.md)
