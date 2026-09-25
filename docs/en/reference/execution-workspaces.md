# Shell, environments and workspaces

When you run a command, it runs on a managed endpoint called a Runner. The selected software environment
provides Python, R, and other tools. Files created by the run live in a Workspace, which is separate from
the software environment. This page covers user-visible execution behavior. For Runner internals and
sandbox design, see [Sandbox execution](../developer-docs/sandbox-execution.md).

| Object | Identity and lifetime |
|---|---|
| Runner | A registered managed local, SSH-tunnel, or direct endpoint; commands always use the Runner sandbox |
| Workspace | A persistent folder for one Agent instance on one Runner; the Session's main Agent and every child have separate roots |
| Environment | A managed Runner-local environment selected by ID and resolved to its latest version; it can contain both Python and R |
| Environment Revision | A record of package state and source, not a selectable historical environment copy |
| Execution | A record of one command that persists independently of the model turn that requested it |
| Transfer | An explicitly started file-copy operation that maps files from a committed source snapshot to a target Workspace |

## Run and observe

Use `run_shell` with either `command` or `scriptPath`, optionally `runner_id` and `environment_id`. Examples include `python -m module`, `python analysis.py` and `Rscript analysis.R`. Each invocation starts a fresh process at the Workspace root. Working-directory and exported-variable changes do not survive into the next invocation; interpreter memory does not persist. Notebook support is not included.

Foreground `wait_ms` is a response-wait budget (default 10 seconds, maximum 30 seconds), not a process timeout. When it expires, the tool returns the still-running Execution ID. `background: true` returns after acceptance. `execution_status`, `execution_logs` and `execution_cancel` query or manage that ID without starting another Shell or taking the Workspace write lock. Only explicit cancellation stops the job; cancellation waits for process cleanup and committed file state before publishing a terminal result.

The Session file panel's **Executions & reminders** section shows jobs, logs, transfers and timers. `unknown` means the final outcome could not be confirmed, for example after a lost response or API restart. It does not mean the command failed to run: inspect the Runner state before deciding whether to retry explicitly. After the Runner accepts a command, the API retries transient status-query failures against the original Execution ID without resubmitting it. Five consecutive retryable query failures also leave the outcome `unknown`; a successful query resets that count.

## Files and attribution

One Workspace admits one writer at a time, including Shell, edits, uploads, transfers and
lifecycle changes. Parallel writes use independent Workspaces. Readers and transfers use committed
snapshots rather than a running command's half-written files. A command reports success only after
cleanup and file-snapshot commit finish. Files, logs, and execution records are retained separately
for later tracing; late record updates do not replace the latest saved file.

`workspace_transfer` discovers permitted Workspace IDs and explicitly starts, lists, queries or cancels transfers. Copies retain their source snapshot and per-file outcomes. Cancellation or partial failure keeps successfully committed files; byte progress alone does not prove publication. Local↔remote and parent↔child copies share this mechanism. No automatic mirror or implicit handoff replay occurs. Only files present in the local owned Workspace may be declared as Artifacts; remote output must first be copied back. Copying alone does not declare an Artifact.

## Environment changes

Use `environment_create`, `environment_install` and `environment_uninstall` to manage packages. The creation language selects initial tools, not a permanent restriction: conda can add Python or R, after which pip or CRAN/Bioconductor can operate in that same environment. Updates change the managed prefix in place without cloning every Revision. Execution resolves the latest state by environment ID and records the actual Revision used. Rebuilding a historical environment is not exposed to the Agent.

The sandbox mounts managed prefixes read-only. Prompt guidance routes package changes to management tools; Shell text is neither intercepted nor rewritten into package-management calls. A long-running reader and a package update are coordinated so an active execution cannot see a partly updated prefix.

## Completion, reminders and stopping

Completion notifications start a new turn when the owner is idle; otherwise they remain queued in the durable inbox. A result the owner already read through a tool call — a foreground `run_shell` wait that outlived the command, or `execution_status` / `execution_logs` on a finished execution — is marked read at that moment and does not start a turn; only an outcome the owner has not seen (a `background: true` submission, a wait that ran out, a reminder) wakes it. Child notifications resume the same child's context and Workspace, not the main Agent's, and a wake turn never rewrites how the child's delegated task ended. `timer_create` accepts exactly one of `after_ms` or timezone-qualified `at`; `timer_list` and `timer_cancel` manage one-time reminders. A reminder may name an `execution_id`; completion cancels its pending reminder. Timers deliver text, not executable commands, and do not acquire a Workspace write lock. Recurring timers are unsupported.

Stop closes the corresponding wake gate; Session Stop and Archive close the Session gate and cancel pending timers. Results and notices remain recorded. A new user request resumes the Session and summarizes unread main-Agent notices without replaying commands. Explicit **Resume** reopens a separately stopped child after the Session has resumed. Restoring an archive alone does not resume automation, and cancelled old timers never reactivate.
