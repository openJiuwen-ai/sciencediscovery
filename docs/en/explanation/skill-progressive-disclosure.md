# Skill Progressive Disclosure

This page explains how a model discovers, reads, and audits Agent Skills during a run. Selected Skills are staged into the sandbox as complete frozen packages, and the prompt still stays light by carrying metadata and paths rather than content.

## Design goals

- Keep the system prompt light: list selected skill name, description, version, revision, package path, and package hash, not full `SKILL.md`.
- Stage every selected Skill as a complete package under a fixed sandbox path before the model loop starts, so no mount, extract, or copy tool call is needed.
- Freeze selected revision, package hash, instructions, and resources at run start, so later reads cannot observe a disk edit.
- Separate discovery from content: the prompt names locations, while file and execution tools read the staged frozen bytes on demand.
- Keep the default package tree read-only, and reserve a separate writable area for later self-evolution.

## Runtime flow

```text
effective Session skills → API frozen revisions
  └─ prepareSkillSandbox writes the complete packages to a per-execution snapshot root
       ↓
  sandbox starts with the packages already mounted
    ├─ /skills                (read-only, $SCIENCEDISCOVERY_SKILLS_DIR)
    │    └─ <skillId>/SKILL.md, scripts/, references/, assets/…
    └─ /skill-extensions      (writable, $SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR)
       ↓
  prompt lists <package_path> and <package_hash> per selected skill
       ↓
  read /skills/<skillId>/SKILL.md with read_file  (read_skill remains a fallback)
    ├─ read referenced supporting text from the same package path
    └─ execute a bundled script in place with explicit argv
```

## Locations

| Path | Mode | Purpose |
|---|---|---|
| `/skills/<skillId>` | read-only | Complete frozen package for one selected Skill, including `SKILL.md`, `scripts/`, `references/`, and assets |
| `/skills/.sciencediscovery-snapshot.json` | read-only | Manifest recording each staged skill id, revision, version, and package hash |
| `/skill-extensions` | writable | Reserved extension area for later self-evolution; empty by default and never part of the frozen tree |

`$SCIENCEDISCOVERY_SKILLS_DIR` and `$SCIENCEDISCOVERY_SKILL_EXTENSIONS_DIR` resolve to these locations inside `run_shell`, `run_python`, and `run_r`, so a skill instruction can quote the variable instead of a hardcoded mount path.

## Tool responsibilities

| Tool | Location | Responsibility |
|---|---|---|
| `read_file` | Node workspace tool | Page through any staged package file under `/skills`, exactly as for a workspace file |
| `run_shell` / `run_python` / `run_r` | Runner sandbox | Execute a bundled script in place from its package path with explicit argv |
| `read_skill` | Node workspace tool | Compatibility channel returning the same frozen instructions and the package path |
| `read_skill_resource` | Node workspace tool | Bounded UTF-8 read of one snapshot resource; never executes scripts or installs dependencies |

Staging happens in `prepareSkillSandbox` (`services/api`), the mounts are applied by `services/runner`, and the tools come from `createWorkspaceTools` in `packages/workspace`.

## Why a staged snapshot rather than the live catalog path

Exposing the catalog's live `SKILL.md` location would let a mid-run disk edit change what the model reads, breaking the fixed revision and package hash recorded in the Prompt Manifest. Staging solves both halves: the model gets an ordinary file path, and the bytes behind it are the frozen revision copied once per execution, verified against the recorded package hash before the sandbox starts.

## Security boundary

- Skill entries injected into the prompt contain metadata and paths, not content.
- Only skills selected for the run are staged; an unselected skill never appears under `/skills`.
- The default package tree is read-only: writes and deletes inside `/skills` fail in the sandbox, and the staged files are mode `0444` on the host.
- Staging a package is not installing or running it. `scripts/` are never auto-executed and dependencies are never auto-installed merely because a Skill is selected; execution requires an explicit argv call from the Agent.
- Large or binary package bytes go from the frozen snapshot straight to disk and never enter model context. Do not read a large bundled script back into context, and do not search the filesystem for package resources — the prompt already carries the path.
- Revision, version, and package hash enter the Prompt Manifest and the staged manifest file, so an execution can be replayed against an exact package.

## Related entry points

- [Agent backend](agent-backend.md)
- [Built-in tools](../reference/builtin-tools.md)
- [Runtime behavior](../reference/runtime-behavior.md)
