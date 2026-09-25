# Import and manage research Skills

Package recurring data checks, literature procedures, or delivery requirements as a Skill. This guide uses a CSV quality check to explain local/Git import and runtime verification. No new MCP service is required.

## 1. Prepare a package

Create `csv-quality-check/SKILL.md` locally with the following content. Match the folder and `name`, use lowercase hyphenated names, and provide a nonempty description.

```markdown
---
name: csv-quality-check
description: Inspect an uploaded CSV for missing values and duplicate rows, and deliver reproducible quality-check results.
---

# CSV quality check

1. Locate the user-supplied CSV and inspect its actual columns and dimensions.
2. Report missing values and duplicate rows. Do not silently delete or impute data.
3. Save the executed code and a concise result table in the workspace.
4. Register the outputs as artifacts and identify limitations in the final reply.
```

Add `scripts/` or `references/` when needed and reference their relative paths. Import the whole folder or ZIP to include supporting files; importing `SKILL.md` alone does not include adjacent files. Do not store tokens or private research data in the package.

## 2. Import from local files or Git

Open the library management view in **System settings → Skills** and choose a file, folder, or Git import:

- **File**: select `SKILL.md` or a ZIP containing the package.
- **Folder**: select the skill directory, preserving script and reference paths.
- **Git**: provide an HTTPS/SSH repository URL and, optionally, a ref and subdirectory. Inspect detected skills before importing. Private repositories use Git credentials or SSH configuration on the backend host; do not place tokens in URLs.

Open the imported Skill and inspect its name, instructions, and supporting files. Packaging a script does not execute it or install Python/R dependencies. Dependencies remain managed through scientific environments.

## 3. Check runtime availability

Library presence and runtime enablement are separate:

- **JiuwenSwarm backend**: inspect runtime skills and switches in the JiuwenSwarm Skills view. ScienceDiscovery skills are imported before runs. These switches apply across sessions, not as individual Specialist allowlists. Restore the runtime connection first if it is unavailable.
- **Backends with Project / Session skill selection**: `all` permits installed skills; `selected` requires adding the new Skill to the effective allowlist. Check whether Session settings override the Project.

Installation does not establish that the Agent read the Skill. Create a test session, upload a small CSV, and explicitly request `csv-quality-check`. Select the matching skill suggestion if offered by the composer. Inspect execution records and artifacts rather than relying on the response mentioning its name.

## 4. Edit it or request an Agent draft

Edit your managed Skill in the manager and inspect saved versions and differences. Built-ins are read-only; import a separately named variant rather than overwriting them.

You can also explicitly ask: “Turn this CSV checking procedure into a reusable Skill.” The Agent produces a pending draft. Review its files in Skills and confirm before it is installed. Review later Git changes too; importing does not imply unattended automatic updates.

- [Scientific MCP and Skills](../core/mcp-skills.md): capabilities included with the product.
- [Create Specialists](configure-specialists.md): use methods in focused roles.
- [Skill library design](../developer-docs/skill-library-management.md): validation, versions, and review.
