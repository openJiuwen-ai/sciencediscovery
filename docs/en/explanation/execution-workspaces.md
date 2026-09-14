# Shell, environments and workspaces

An execution names a Runner and an environment ID. The Runner supplies the sandbox; the environment supplies Python, R and other installed tools. An environment is not a machine, and a Workspace is not an environment.

| Object | Identity and lifetime |
|---|---|
| Runner | A registered local, SSH-tunnel or direct endpoint; executes only through the Runner sandbox |
| Workspace | One persistent directory per Agent instance × Runner; the main Agent belongs to its Session, and every child has a separate root |
| Environment | A Runner-local ID resolving to the latest managed prefix; Python and R may coexist |
| Environment Revision | An audit record of package state and provenance, not a selectable runnable historical copy |
| Execution | A durable command record, independent of the requesting model turn |
| Transfer | Explicit file mappings from a committed source snapshot into a target Workspace |

## Run and observe

Use `run_shell` with either `command` or `scriptPath`, optionally `runner_id` and `environment_id`. Examples include `python -m module`, `python analysis.py` and `Rscript analysis.R`. Each invocation starts a fresh process at the Workspace root. Working-directory and exported-variable changes do not survive into the next invocation; interpreter memory does not persist. Notebook support is not included.

Foreground `wait_ms` is a response-wait budget (default 10 seconds, maximum 30 seconds), not a process timeout. When it expires, the tool returns the still-running Execution ID. `background: true` returns after acceptance. `execution_status`, `execution_logs` and `execution_cancel` query or manage that ID without starting another Shell or taking the Workspace write lock. Only explicit cancellation stops the job; cancellation waits for process cleanup and committed file state before publishing a terminal result.

The Session file panel's **Executions & reminders** section shows jobs, logs, transfers and timers. `unknown` means the final outcome could not be confirmed, for example after a lost response or API restart. It does not mean the command failed to run: inspect it before making an explicit retry.

## Files and attribution

One Workspace admits one writer at a time, including Shell, edits, uploads, transfers and lifecycle changes. Parallel writes use independent Workspaces. Readers and transfers use committed snapshots rather than a running command's half-written files. A successful receipt follows process cleanup and CAS/ref commit. Workspace bytes use the data pool; logs and Agent state use the agent-state pool. Late provenance retains its history without moving the latest file pointer backwards.

`workspace_transfer` discovers permitted Workspace IDs and explicitly starts, lists, queries or cancels transfers. Copies retain their source snapshot and per-file outcomes. Cancellation or partial failure keeps successfully committed files; byte progress alone does not prove publication. Local↔remote and parent↔child copies share this mechanism. No automatic mirror or implicit handoff replay occurs. Only files present in the local owned Workspace may be declared as Artifacts; remote output must first be copied back. Copying alone does not declare an Artifact.

## Environment changes

Use `environment_create`, `environment_install` and `environment_uninstall` to manage packages. The creation language selects initial tools, not a permanent restriction: conda can add Python or R, after which pip or CRAN/Bioconductor can operate in that same environment. Updates change the managed prefix in place without cloning every Revision. Execution resolves the latest state by environment ID and records the actual Revision used. Rebuilding a historical environment is not exposed to the Agent.

The sandbox mounts managed prefixes read-only. Prompt guidance routes package changes to management tools; Shell text is neither intercepted nor rewritten into package-management calls. A long-running reader and a package update are coordinated so an active execution cannot see a partly updated prefix.

## Completion, reminders and stopping

Completion notifications start a new turn when the owner is idle; otherwise they remain queued in the durable inbox. Child notifications resume the same child's context and Workspace, not the main Agent's. `timer_create` accepts exactly one of `after_ms` or timezone-qualified `at`; `timer_list` and `timer_cancel` manage one-time reminders. A reminder may name an `execution_id`; completion cancels its pending reminder. Timers deliver text, not executable commands, and do not acquire a Workspace write lock. Recurring timers are unsupported.

Stop closes the corresponding wake gate; Session Stop and Archive close the Session gate and cancel pending timers. Results and notices remain recorded. A new user request resumes the Session and summarizes unread main-Agent notices without replaying commands. Explicit **Resume** reopens a separately stopped child after the Session has resumed. Restoring an archive alone does not resume automation, and cancelled old timers never reactivate.
