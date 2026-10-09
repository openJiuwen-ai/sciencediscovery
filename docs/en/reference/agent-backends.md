# Agent backends

ScienceDiscovery's launchers use **JiuwenSwarm by default** in local source, Docker, and packaged deployments. The older native Node loop remains available with `--no-jiuwenswarm` (or `SCIENCE_AGENT_EXECUTOR=native`). Install JiuwenSwarm before the first source start with `scripts/jiuwenswarm.sh setup`; the Docker image and packaged launcher provide their own runtime. A direct API process without the launcher still selects native when `SCIENCE_AGENT_EXECUTOR` is unset.

| Startup | Agent executor | Public `:4310` | API |
| --- | --- | --- | --- |
| `./scripts/start-stack.sh --mode local` | JiuwenSwarm | adapter | `:4410` |
| `./scripts/start-stack.sh --mode docker` | JiuwenSwarm | adapter | `:4410` |
| `./scripts/start-stack.sh --mode local --no-jiuwenswarm` | native | API | `:4310` |

The adapter bridges runs to JiuwenSwarm and proxies remaining HTTP routes to the API. The API still owns Projects, Sessions, permissions, workspace tools, Runner execution, Artifacts, provenance, and run events. JiuwenSwarm holds its own model conversation and context; editing or rolling back the API's visible history does not rewrite that conversation. Model calls pass through the adapter and API model gateway. Check the active public front door with authenticated `GET /agent/info` in JiuwenSwarm mode.

## JiuwenSwarm behavior and switches

These switches apply only when `SCIENCE_AGENT_EXECUTOR=jiuwenswarm`. Set them before starting the stack.

| Variable | Default | Effect |
| --- | --- | --- |
| `SCIENCE_AGENT_JIUWENSWARM_PROMPT` | `prepend` | Product prompt precedes JiuwenSwarm's prompt; `replace` uses only the product prompt and explicit run rules. |
| `SCIENCE_AGENT_JIUWENSWARM_TOOLS` | `jiuwenswarm` | Its Web, memory, Skill, and other available tools supplement product tools; `ours` lists product tools instead. Host acting Swarm tools (`bash`, direct file writes/reads, `glob`, `grep`, `read_pdf`) are blocked; use product workspace tools such as `run_shell`. |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | `todo` | JiuwenSwarm todo tools provide the plan when planning is enabled; `update_plan` selects the product tool. |
| `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS` | `task` | Platform `task` dispatches an independent child run, also executed by JiuwenSwarm, with product sandbox, permissions, handoff and audit. `jiuwenswarm` opts into native `subagent_spawn`/`subagent_wait`. |
| `SCIENCE_AGENT_JIUWENSWARM_SKILLS` | `jiuwenswarm` | With the default prompt and tools, selected Skills are installed for `skill_tool`; `ours` retains product Skill loading. `read_skill` and `read_skill_resource` are fallback paths when JiuwenSwarm loading fails. |

With default JiuwenSwarm tools, product `web_search`/`web_fetch` are replaced in the model's tool list by JiuwenSwarm `free_search` or `paid_search` and `fetch_webpage`. Product tools without a JiuwenSwarm counterpart remain available. Native Swarm subagents have a different boundary: they do not receive the platform task workspace, product tools, approval flow, handoff, provenance, or task cards. Use `task` for those features.

Some implementation pages describe only the **native executor**, including [Agent backend](../developer-docs/agent-backend.md), its context compaction, repeated-tool-call thresholds, and native deferred-tool visibility. Their statements do not automatically apply to JiuwenSwarm. See [runtime architecture](../developer-docs/architecture.md), [subagent orchestration](../developer-docs/subagent-orchestration.md), and the [historical migration record](jiuwenswarm-migration-status.md) for more detail.
