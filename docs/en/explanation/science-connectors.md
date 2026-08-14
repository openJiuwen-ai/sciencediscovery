# Scientific MCP and External Data Sources

## 1. Single runtime path

```text
Agent MCP tool → Node MCP Governance Broker → Python gateway MCP client
               → Python MCP server → CAS/cache/permission/audit
               → normalized McpToolResult
```

Legacy `invoke_connector`, `ConnectorBroker`, `ScienceSource`, and direct Node-provider paths are removed. See [MCP tool and protocol design](mcp-tool-protocol.md).

## 2. Responsibility boundary

- Python MCP performs provider queries, parameter/response validation, transient retry, and standard result construction.
- Node owns registry, Session authorization, identity/URL allowlist validation, concurrency/rate limiting, cache, CAS, and audit.
- External result content is always untrusted data.
- PDF worker handles only a completed local PDF and never performs retrieval.

Implementations are `packages/mcp-sources`, gateway `*_mcp.py`, API `mcp/`, `packages/agent-runtime`, and `services/paper`.

## 3. Tool injection and model visibility

Three filters precede deferred model visibility.

### 3.1 Node injection path

1. Registry manifests declare MCP name, schema, permission, cache, routing, and prompt/citation information.
2. `McpSourceCatalog` compares actual gateway server/tools and compatible input schemas. Missing/incompatible tools enter `missingTools` and are hidden.
3. `createMcpWorkspaceTools` keeps only Session-enabled, catalog-available tools, names them `mcp__<sourceId>__<toolId>`, and executes through `McpGovernanceBroker`.
4. `createWorkspaceTools` marks MCP tools `deferred:true` with keyword/mode/priority routing; built-ins are not deferred.
5. `GatewayAgent` posts name/description/schema/deferred/routing. Execution still callbacks Node.

### 3.2 Gateway visibility

When deferred tools exist, DeerFlow `assemble_deferred_tools` adds `tool_search` and a name-only catalog to the prompt. `DeferredToolFilterMiddleware` removes unpromoted schemas from model `bind_tools` and rejects direct calls with guidance to search first. Promotions bind to a catalog hash and expire after tool/schema changes. Keyword `prefer` routing can automatically promote up to three matches before the call.

Thus built-ins are fully visible; MCP names are visible but schemas appear only after search/automatic promotion, and only after catalog availability and Session enablement.

## 4. Initial sources

Literature: PubMed, arXiv, Europe PMC, bioRxiv, medRxiv. Databases: UniProt, PDB, Ensembl, Reactome, ClinVar, ChEMBL, GEO. A missing or incompatible tool makes its source degraded and unavailable to the Agent.

## 5. Download and PDF extraction

1. MCP query/prepare returns an `ArtifactCandidate` without downloading.
2. A later `artifact_download` waits for terminal download state.
3. After success, a new model turn invokes `paper_extract_pdf`.
4. The Agent continues from text path, manifest, and warnings.

Independent same-turn tools run concurrently; a download and its dependent extraction cannot share a turn. There is no initial DAG/`dependsOn` API.

## 6. Audit and citation

Every MCP invocation records CAS references for request/raw/normalized response plus source, tool, attempts, cache, permission, license, and error. Candidate source/identifier/citation identity must match and URLs must be HTTPS on manifest-allowed hosts. Database record, abstract, and extracted full text have distinct `contentScope`; full-text claims require successful extraction. Claim/Evidence review accepts only governed MCP or traceable execution.

## 7. UI state

The current UI offers basic candidates, job status, cancel/retry, and invocation count. Legacy connector search/import is removed. Full Source/Tool/Invocation/ExtractionJob/permission UI is not yet implemented. Dangerous actions ask individually by default; Allow same type creates a Session grant and releases matching pending actions; Always allow appends an authorization per action without a wildcard grant.
