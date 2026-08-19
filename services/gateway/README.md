# services/gateway — bundled Python MCP servers

**This is not a service.** It has no HTTP port, no FastAPI application, and the
start-up script does not launch it. The agent loop, model transport, MCP client,
and web providers all run natively in the Node control plane (see
[Agent backend](../../docs/en/explanation/agent-backend.md)).

What remains is the two bundled provider-facing MCP servers and the external-URL
registry they share:

- `src/science_agent_gateway/public_biomed_mcp.py` — public biomedical sources
- `src/science_agent_gateway/uniprot_mcp.py` — UniProt records
- `src/science_agent_gateway/external_urls.py` — the operator-visible URL registry

Both speak MCP over stdio. The Node control plane spawns them as subprocesses
using this environment's interpreter (`resolveMcpPython()` in
`services/api/src/mcp/node-client.ts`), and remains authoritative for
governance, permissions, caching, and downloads.

The package therefore depends only on `mcp` and `httpx`. It once installed the
`deerflow-harness` vendor package; that dependency, and the submodule it came
from, were removed once the agent loop and the web providers had moved into
Node. `services/gateway/tests/test_architecture_boundaries.py` fails if a
vendor reference reappears anywhere in the package.

## Setup

The repository run script provisions this environment automatically at
`<data dir>/envs/gateway` (Python 3.12 via `.python-version`). It is still
provisioned even though no gateway process is started, because the MCP servers
run from it.

For standalone development:

```bash
cd services/gateway
uv sync                                   # creates ./.venv
.venv/bin/python -m science_agent_gateway.uniprot_mcp   # speaks MCP on stdio
```

## Tests

```bash
cd services/gateway && .venv/bin/python -m unittest discover -s tests
```
