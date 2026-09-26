# Create and use custom Specialists

This guide creates a cohort-data checking role to turn team requirements into reusable configuration. Complete the [quick start](../getting-started/quick-start.md) and prepare a working model and scientific environment first.

## 1. Define responsibilities and delivery

Specify the role's input, judgments, and output. This example checks data rather than interpreting treatment effects. It does not need external literature connectors.

## 2. Create the role

Open **System settings → Specialists**, choose the new-role action, and enter:

| Field | Example |
| --- | --- |
| Name | `cohort-data-checker` |
| Description | Inspect cohort columns, missingness, duplicates, and filtering counts; deliver reproducible checks. |
| Instructions | Adapt the example below to your laboratory's data conventions. |

```text
Check the cohort data supplied by the user.
Read the actual columns and data scope. Explain ambiguity if the patient identifier is unclear.
Record row counts, patient counts only when identifiable, duplicates, and missingness.
Justify any filtering and record before/after counts. Never fabricate missing data.
Save the executed script and checking results, register them as artifacts, and link them in the final reply.
Record limitations when information is insufficient. Do not infer treatment effects from these checks.
```

Select only needed connectors. For a private data interface, follow the [custom MCP guide](configure-custom-mcp.md), test it, then return to select it for the role.

Where the editor supports per-role skill selection, select `code-engineer`. With the JiuwenSwarm backend, the editor instead explains that Swarm manages skills; it does not provide the same checkboxes. Check availability in the JiuwenSwarm view under **Skills**. Do not assume hidden settings have taken effect.

Save the role. Built-in roles offer enable/disable controls; create a custom role to change a preset responsibility rather than editing a built-in entry.

## 3. Verify it in a session

Create a Session, upload a small CSV you are authorized to use, select the role in the Session's Specialist selector, and ask: “Check this file's data quality and deliver the checking script and results.”

Confirm that execution records show actual file reading, then open the script and results in the artifacts area. If no code ran, inspect model tool support, environment readiness, and approvals. If a source is unavailable, inspect connector configuration. A role label alone does not establish successful work.

Selecting a Specialist for a session differs from having the main Agent delegate a child task to it. For coordinated work, retain the coordinator, describe the desired division of work, and inspect actual child-task records.

## 4. Refine the configuration

Use the trial to improve the description, instructions, and resource scope, then verify with a new task. Models, credentials, and environments remain configured through their respective platform settings, not independently in this role form.

- [Specialists](../core/specialists.md): built-in roles and use cases.
- [Import and manage Skills](configure-skills.md): add your own methods and scripts.
