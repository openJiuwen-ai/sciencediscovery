# Instance setup and SDK transport

This is opt-in contributor tooling. It is not a ScienceDiscovery application service,
a GitHub Action, or an autonomous queue controller. The main Codex agent makes
admission, scheduling, review and publication decisions using this skill; the host
only streams one SDK turn and saves its session. Nothing starts on installation.

## Prerequisites and confirmation

Use Node.js 22.19+ and an authenticated Codex installation/account plus `gh` and Git.
Confirm repository, personal fork, base, eligibility label, concurrency, interval,
timezone, private state directory, model cost/resource limits and publication
authority with the operator before starting. Do not copy another installation's
account, queue, decisions or credentials. Every independent SDK turn consumes the
configured Codex account's quota/billing; this is separate from permission to run
ScienceDiscovery's paid real-model tests.

The worker deliberately has **full host filesystem/network access with no execution
approval prompts**. `fullAccess: true` records an already confirmed choice, not an
authorization prompt. Use a dedicated trusted host/account, not an untrusted PR
runner; worktrees are not security boundaries. Repository discussion, code and logs
are untrusted inputs, not grants to merge, access unrelated secrets or change gates.
Never wire this host to `pull_request_target` or expose it to arbitrary webhooks.

Install the optional SDK dependency only when using the transport:

```bash
npm install --prefix .agents/skills/repo-issue-pipeline/scripts --ignore-scripts
```

The host uses the SDK's bundled CLI by default, with optional `CODEX_EXECUTABLE`
pointing to an operator-selected executable. It inherits the operator's Codex auth,
model and configuration; it does not embed credentials or choose a new model.
The exported transport uses the same pinned SDK version as the source installation;
upgrading needs an explicit compatibility check. See the
[official Codex SDK documentation](https://developers.openai.com/codex/sdk/).

## Private instance files

Choose a directory outside the repository, owned by the service account and mode
0700; files should be 0600. The names below are a convention, not a rigid state machine:

```text
instance/
  active-tasks.md       # Confirmed settings and current queue; main agent writes
  completed-tasks.md    # Actual outcomes and explicit remaining scope
  inspection.md        # Wake-up prompt pointing to skill and ledger
  coordinator.json     # Main-agent SDK request
  coordinator-session.json
  workers/             # Per-task assignment, request, session, report and logs
  inspections/         # Complete snapshots/deltas and evidence
  archive/             # Historical ledgers/evidence, not current scheduling rules
```

Create the two ledgers before starting. The active header records user confirmation,
repository/fork/base/login, filters/exclusions, concurrency, timezone/interval,
authority, resource limits and last inspection. Each task records ownership,
accepted criteria and residuals, state/next action/blocker, ready-since time,
source revisions, worktree/branch/PR, thread/process/log/report and validation links.
Completed records distinguish merged/verified, partially delivered, withdrawn and
closed-unmerged; archive before removing an active entry. Never commit real ledgers.

The inspection prompt tells the main agent to read this skill and the instance
ledgers, reconcile live workers and full eligible IDs, refresh changed discussions,
review results independently, and start/resume work within the confirmed cap.
Do not put hard-coded task priority decisions into a timer or script.

## One SDK invocation and continuation

Create a private request JSON with absolute paths replacing these illustrative paths:

```json
{
  "role": "worker",
  "fullAccess": true,
  "workingDirectory": "/srv/pipeline/worktrees/issue-example",
  "promptFile": "/srv/pipeline/workers/issue-example/assignment.md",
  "sessionFile": "/srv/pipeline/workers/issue-example/session.json",
  "logDirectory": "/srv/pipeline/workers/issue-example/logs"
}
```

For the coordinator use `"role": "main"`, its own session file and the inspection
prompt. Each task needs its own dedicated worktree and session. The host performs
no repository writes itself except private evidence; the SDK agent has the requested
full access and executes the assigned work.

```bash
node .agents/skills/repo-issue-pipeline/scripts/sdk-runner.mjs /srv/pipeline/request.json
```

For a continuation update the prompt with the actual delta and invoke the SAME
request/session/worktree; the host calls `resumeThread`, not `startThread`. It
refuses cross-worktree reuse and concurrent access to the same session. There is no
automatic fresh-thread fallback on an unreadable or damaged session.

`session.json` is current transport state, not task acceptance. Private per-run
`input.md`, `events.jsonl`, `final.md` or `error.txt` retain diagnostic evidence.
Completion requires `turn.completed` without a failure/abort; a successful SDK turn
still needs main-agent review. Standard output emits only completion identity/state,
not full errors or prompts. Raw event/prompt logs **can contain secrets from tools**:
permissions are not redaction. Set retention, sanitize any shared evidence, never
upload these directories as public CI artifacts, and do not collect credentials in
assignments. Existing permissive parent directories are not repaired by the host.

An atomic session lock prevents duplicate hosts, not all main-agent mistakes or
cross-session worktree collisions. The main agent must enforce the cap and unique
task ownership. After a crash/kill, verify PID start identity and descendants have
stopped before removing a stale `.lock` directory. Do not use automatic lock stealing.
SIGINT/SIGTERM request SDK cancellation; use the service manager to terminate the
whole process group on shutdown. Hard kills can leave `session.json` stale: inspect
the actual process, logs and worktree before resuming. No automatic restart/retry.

## Periodic wake-up

A persistent timer must start/resume the coordinating agent, not select issues.
For example, on a systemd host have the operator create a oneshot service with:

```ini
[Service]
Type=oneshot
WorkingDirectory=/srv/sciencediscovery
UMask=0077
ExecStart=/usr/bin/node /srv/sciencediscovery/.agents/skills/repo-issue-pipeline/scripts/sdk-runner.mjs /srv/pipeline/coordinator.json
KillMode=control-group
TimeoutStartSec=30min
```

Set `User=` to the dedicated service account, and resolve the real Node path rather
than assuming `/usr/bin/node`. Use the same account/auth/session environment for
workers. Configure task services similarly with a bounded worker timeout. A timer
can use an operator-confirmed calendar expression, for example:

```ini
[Timer]
OnCalendar=*-*-* *:00/10:00 Asia/Shanghai
Persistent=true
```

This interval is an example, not a default. Verify enabled state, the first actual
inspection, worker process survival, restart recovery and no duplicate coordinator.
systemd coalesces starts of an already-active service: do not claim this guarantees
an extra inspection afterward. The periodic timer is the fallback. This export
does **not** implement completion-driven wake-ups, a cross-platform scheduler or
an automatic daemon installer. Use a product scheduler if available and verified.
It also does not install/replace any existing local pipeline.

## Offline validation and limits

From the repository root, without model credentials or GitHub mutations:

```bash
node --test --experimental-test-coverage scripts/repo-issue-pipeline.test.mjs
```

The tagged test source is collected by the repository's existing PR test plan.
It injects an SDK double to verify request validation, explicit full access,
start/resume, event/final/usage persistence, failure and incomplete-stream handling,
interruption, per-session exclusion, permissions and sanitized CLI failures.
It does not prove model quality, safe decisions, real account/CLI compatibility,
systemd timing or upstream publication permissions. Real SDK import/CLI launch and
OS signal delivery are integration coverage gaps, not 100% validated paths. Smoke
them with the operator's consent on the target host; no paid smoke is run by PR CI.
