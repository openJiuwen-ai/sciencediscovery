# Independent Idea Tree service

This service owns autonomous research, historical read-only trees, research settings,
and the agent's MCP tool contracts. It imports no evolve modules. Evolve can stop or
restart without interrupting research. Run **one ASGI worker**.

`scripts/start-stack.sh --mode local` provisions and starts it; Docker includes the
same package. To run it independently from the repository root:

```sh
export SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN="<service-only token>"
uv run --project services/idea-tree --locked python -m sciencediscovery_idea_tree.server
```

| Configuration | Default |
| --- | --- |
| `SCIENCE_AGENT_IDEA_TREE_HOST` | `127.0.0.1` |
| `SCIENCE_AGENT_IDEA_TREE_PORT` | `4314` |
| `SCIENCE_AGENT_IDEA_TREE_URL` (API client) | `http://127.0.0.1:4314` |
| `SCIENCE_AGENT_IDEA_TREE_INTERNAL_TOKEN` | Required for standalone launch; stack supplies a local default |
| `SCIENCE_AGENT_IDEA_TREE_DATA_DIR` | `<SCIENCE_DISCOVERY_DATA_DIR>/idea-tree` |
| `SCIENCE_AGENT_IDEA_TREE_LEGACY_DATA_DIR` | Previous shared data root |

On first startup, `idea-trees/` and `idea-research/` JSON records are copied from the
legacy root into the service directory. Originals are retained for rollback; the
`legacy-import.json` marker prevents old state overwriting subsequent research.
Conflicting target records fail startup rather than overwriting either copy. Stop
the old stack before upgrading. Existing settings are imported lazily from the API
catalog once; subsequent changes are owned exclusively by `settings.json` here.

## MCP and control-plane boundary

The trusted API provisions a five-minute capability via `POST /mcp/scopes` with its
service token, session/project identity, and (for create/continue) a run-bound model
callback. The returned token selects `/mcp/<token>`, a stateless Streamable HTTP MCP
endpoint supporting initialize, tools/list, tools/call, ping, notifications and
DELETE. Revoking the transport capability does not stop autonomous research.

Tools: `create_idea_research`, `get_idea_research`, `control_idea_research`, and
`view_idea_tree`. Tool arguments contain neither session identity nor credentials.
The API reads `/mcp/tools` and contributes those schemas to the existing JiuwenSwarm
MCP bridge (and native executor); it calls the scoped service MCP endpoint. Research
keeps its model grant after the initiating chat turn finishes. Paused/completed
research retires its grant, and continuing issues a new grant for the pinned model.

Session ownership, chat messages and model secrets still belong to the existing
control plane. Its six frontend routes keep their paths and response shapes and
forward research commands, SSE bytes, graph reads and settings to this process.
The adapter currently proxies these frontend routes through that control plane;
moving session/model ownership is tracked separately by the migration issues.
`python-client.ts` is removed; `packages/idea-tree` retains compatibility types and
read transport for historical trees, while active tool schemas and state transitions
are served here. Old `tree_*` mutating tools remain disabled.

Research uses the existing run-token LLM callback pending #102. It never receives
a provider API key. Prepared evidence/source references are preserved in research
state; this extraction does not change the artifact/CAS ownership tracked by #98.
Skill deletion checks query `/references/skill` as well as historical chat runs.

## Verification

```sh
pnpm idea-tree:test
node --import tsx --test packages/idea-tree/src/client.test.ts
```

L1 mappings: the existing `idea-evolve-memory-reads` case covers the research and
graph rows; `idea-tree-settings-noop` adds the settings PUT row. Service tests cover
scoped MCP calls, settings migration, persisted state and real-engine SSE. The local
service journey in `test/api/idea-tree-service-journey.py` drives the installed CLI
with a local stub model and records numbered outcomes without paid model calls.
