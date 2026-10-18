# Opt-in Issue-to-PR contributor pipeline

The [repository issue pipeline skill](../../../.agents/skills/repo-issue-pipeline/SKILL.md)
packages the contributor workflow as a main-agent policy, independent Codex SDK
workers and private text ledgers. It does not change the ScienceDiscovery product
runtime or start a bot when cloned.

```text
Periodic wake-up → Main Codex agent → Independent SDK workers → Fork pull requests
                          ↕                    ↓
                   Private text ledgers ← Reports / test evidence
```

The main agent checks ownership before admission, confirms the problem on current
main, schedules within the agreed cap, reviews completed work and tracks PRs until
the accepted Issue scope is delivered. Workers own analysis, implementation, tests,
documentation and fork PR maintenance; continuations resume the original thread.
CI failures, meaningful review comments, conflicts and accepted residual work stay
in the pool. Waiting for an external decision does not occupy a worker slot.

Read the [setup and transport guide](../../../.agents/skills/repo-issue-pipeline/references/setup.md)
before enabling it. Confirm repository/fork/base, eligibility label, concurrency,
inspection frequency/timezone, state location and authority/cost/resource limits.
No personal account, existing task queue, credentials or service installation is
included. Independent workers run with explicitly authorized full host access;
this is not a sandbox or an untrusted-public-PR automation service.

Repository polling and engineering decisions remain agent-owned, not a scripted
state machine. The small SDK host only persists one streamed turn, its original
thread ID and private diagnostics. Periodic service configuration is documented,
not installed automatically; completion-event wake-ups are not implemented.
The skill's behavioral rules require operator oversight and cannot be certified by
transport unit tests. Merging, queue entry, releases, settings/secrets changes,
gate weakening and paid real-model tests need their own authorization.
