# Plugin mechanism

ScienceDiscovery organizes `packages/` by capability ownership. Components enter the API
and Web hosts through plugin entry points. A plugin is a **trusted extension installed at
build time**, not another implementation of a capability alongside its domain package.
`services/` starts and composes processes. The current work preserves AgentLoop, tool
names, permissions, Project configuration, and storage semantics.

This page describes the current implementation. Requirements are tracked in
[Issue #80](https://gitcode.com/openJiuwen/sciencediscovery/issues/80). For related
runtime behavior, see [Agent backend](agent-backend.md),
[Subagent orchestration](subagent-orchestration.md), and [CAS](cas.md).

## 1. How the platform and plugins work together

```text
installation catalog + global/project/session configuration
                  │ validation, capability negotiation, frozen Run composition
                  ▼
             NativeAgent / plugin host
                  │ inject domain Ports, create → start → dispose
         ┌────────┼───────────┬───────────────┐
         ▼        ▼           ▼               ▼
       tools   context     stateProviders  batchPolicies
         │     factories      │               │
         ▼        └───── StateView ────┐       │
    ToolRegistry                 ContextAssembler
         │                            │
         └──────── AgentLoop ─────────┘
                 model ↔ tools
                      │
          Recorder / permission approval / Runner / CAS

Web plugin entry points → settings, Project panels, Artifact views
                      │
               authenticated scoped Bridge → SessionStore / domain commands
```

| Owner | Maintenance responsibility | Code entry points |
| --- | --- | --- |
| Platform | AgentLoop stop/tool loop; ToolRegistry execution, permissions, and result commit; ContextAssembler budgets, projections, and validation | `packages/runtime-core`, `packages/tools`, `packages/context` |
| API host | NativeAgent composition, domain Ports, configuration freezing, state checkpoints, and Recorder wiring | `services/api/src/native-agent/`, `services/api/src/plugins/` |
| SDK | manifest, lifecycle, service contracts, configuration validation, Bridge, and runtime-contribution types | `packages/plugin-sdk/src/` |
| Installation catalog | States which trusted packages ship with the product; never executes user-supplied entry strings | `services/api/src/plugins/catalog.ts` |
| Web host | Registers settings, Project views, and preview entries; provides UI capabilities and an authenticated Bridge | `apps/web/src/plugins/` |
| Capability component | Keeps domain implementation, contributions, manifest, configuration, and views in one package; uses Ports for external capabilities | public `./plugin`, `./manifest`, and `./web` entries in `packages/*` |

Runtime contributions use `RuntimeContribution`: `tools`, `contextFactories`,
`stateProviders`, `batchPolicies`, and optional `commitResult`. This is not an arbitrary
callback registry. State writes go through domain commands, and notifications cannot bypass
authoritative data. Tools remain subject to ToolRegistry and existing permissions and
approvals.

### Directory ownership and one-way dependencies

`packages/` answers “who owns this capability?” It does not imply a package must be a
public library. `services/` answers which process starts and deploys. `apps/web` is the
browser shell. The repository does not maintain a second top-level `plugins/` capability
tree. `services/api/src/plugins` and `apps/web/src/plugins` compose hosts; they are not
copies of domain implementations.

Code dependencies are `services/apps → capability components → shared contracts/base
capabilities`, and the package graph must be acyclic. Runtime callbacks may point to a
host implementation, but components cannot import their host back. For example, Plan
declares `PlanStore` and the API injects its implementation. A component owns state
commands and projections; the host provides authoritative storage and transactions. This
does not establish two databases that write the same data.

- Cross-package access uses only `package.json.exports`; relative paths must not enter
  another package's `src`, including for types.
- `./plugin` is the runtime-contribution entry, `./manifest` the lightweight description,
  and `./web` the browser entry. A domain root entry does not re-export a Node plugin
  factory, and Web does not import server code through a root barrel.
- The consuming capability or owning domain package normally defines an interface. Extract
  a contract package only when independent reuse/publication or removal of an actual cycle
  requires it. A shared interface must not depend on a concrete Provider.
- A feature-specific worker may live beside its component. A separate process does not
  create another feature owner. Services communicate through protocols; a component
  factory does not read global environment variables or start product services itself.
- Required, replaceable, and user-disableable are independent properties. Future platform
  implementations may be componentized, but this work does not replace the Loop,
  permission, or execution protocol.

`pnpm architecture:check` includes positive/negative tests plus source and manifest-graph
checks. It detects reverse host dependencies, cycles, non-public cross-package imports,
and Node builtins reached through `./web`, `./manifest`, or `./views` in repository runtime
dependency chains. It parses static imports, re-exports, type imports, and literal dynamic
imports/requires. Non-literal dynamic loading and third-party package internals still need
build and review controls; this is not a security sandbox.

**Explicitly retained debt:** `packages/executor → @sciencediscovery/runner` remains. It
involves signatures, deployment versions, scientific-environment provisioning, and Runner
distribution, and predates this plugin work. The check allows only exact existing
file/dependency edges in its allowlist. It does not allow new files or exempt cycle checks.
Migrating it requires a separate review of the Runner contract and distribution artifacts.
The six components in this work have no reverse host dependency, but this does not claim
all repository services are already thin.

## 2. Plugin packages, lifecycle, and activation

A plugin package declares its identity and contract through `PluginManifest`: `id/version/apiVersion`,
`entries`, required dependencies, `services`, `permissions`, `configuration`, and
`contributes`. `settingsFields` lists existing domain fields that the plugin settings entry
may change. For example:

```text
packages/plan/
  package.json          exports point at built artifacts
  src/index.ts          domain tools, PlanStore, and context implementation
  src/manifest.ts       description without Node runtime resources
  src/plugin.ts         API runtime-contribution factory using this package's domain code
  src/web.tsx           independent Web entry
```

The host distinguishes four states: **installed** means the package is in the catalog;
**available** means dependencies and service contracts are met; **authorized** means the
host granted required capabilities; **active** means the current scope started it
successfully. Missing required services, version mismatches, and disabled dependencies
produce diagnostics; optional services may be absent. API-catalog availability does not
mean a particular Run activated the plugin.

`createPluginScope` creates and starts in dependency order, cleans up created instances on
failure, and disposes in reverse order. `start` receives an `AbortSignal`, and cancellation
must reach asynchronous work. Resource release must be idempotent. These are trusted
in-process extensions; manifest permission checks are not isolation against malicious code.

Configuration overlays **global → project → session** and merges plugin configuration by
ID and field. Omission inherits; `enabled:false` explicitly disables. A plugin can declare
`configuration.applies` as `nextRun` or `restart`. All currently installed plugins declare
`nextRun`; that does not promise general hot reload. Data-source adapters compose at
startup. Project settings filter sources for the next Run rather than dynamically removing
process-level adapters.

**UI and composition are separate:** the optional-extension section only exposes a JSON
preview switch. It does not expose a separate global switch for UniProt or another built-in
MCP type. Skills, MCP, Plan, and default multi-Agent scheduling also have no global switch.
Users still choose individual Skills, MCP services, and connectors at their own entries.
The backend configuration API still supports Project/Session enablement, inheritance, and
next-Run freezing for every plugin. Existing configuration remains unchanged: no data is
migrated and nothing is enabled automatically.

When a run begins, it freezes the configuration, Skill assets, and other composition. Main
Agents, Subagents, and reviewers choose the same composition and install contributions in
their scopes. Editing while a run is active cannot change its frozen tool set. Frontend
settings/viewers refresh their displayed selection; historical Plans and Artifacts remain
readable. Disabling an execution contribution neither removes history nor prevents later
reconfiguration.

## 3. StateView, model context, and versions

Complete Agent state is not one freely writable shared plugin object. It combines named
state fragments at a checkpoint:

```text
domain command → StateProvider.capture
                 │ { id, schemaVersion, revision, value, fidelity }
                 ▼
           frozen StateView
                 │ contributor declares stateReads and reads only required fragments
                 ▼
     context projection → budget/truncation/validation → actual model input
                 └────────────────────────────────────→ Recorder provenance at same checkpoint
```

`StateCoordinator` coordinates domain commands, migration, and capture. The Plan plugin
uses it to wrap updates and snapshot reads. `captureStateView` repeatedly compares captured
state; if it continues changing after limited retries, it fails. An externally unfrozen
observation is `reference-only`, captured once at a checkpoint and excluded from the local
consistency barrier. Ongoing sibling-Agent progress therefore cannot prevent an Agent from
starting. A new checkpoint observes again; model projection and Recorder use the same
frozen value. This is not a cross-service transaction and does not make reference
observations an atomic snapshot with local state.

`schemaVersion` describes data format and `revision` one component's state version. A
checkpoint associates fragments. Neither is a plugin-package version or configuration
composition revision. `StateView` validates unique IDs and versions and isolates mutable
references. Contributors restrict reads through `stateReads`. Missing required state fails
instead of reading newer data during context construction.

Before invoking the assembler, NativeAgent captures a checkpoint and passes the frozen view
to `DynamicContextAssembler`; contributors then generate content from that same view.
Recorder uses the matching state and context record rather than rereading live state after a
model invocation. See `packages/context/src/{state-view,state-coordinator,dynamic-assembler}.ts`
and `services/api/src/native-agent/`.

**Compatibility boundary:** Plan's `createPlanContextFactory(scopes)` no longer receives a
store and fails without `StateView`. Some generic contributors in `durable-state.ts` and
NativeAgent's `tools.capabilities` retain old no-StateView branches. Production dynamic
composition supplies StateView and does not use them. New plugins must not copy the live
fallback, and independent consumers of old contributors must not claim their results are
frozen checkpoint projections.

## 4. Bridge and unified settings writes

Web delivers host-registered component/view factories through its independent `./web`
entry. The settings host provides forms, translation, and icons; Project views and Artifact
previews compose through their corresponding registration entries. This is not “upload any
React file and execute it”, and it does not give a browser database, credentials, or a
NativeAgent instance.

Bridge reuses existing API bearer authentication and the single-user control plane. Its path
is `/api/projects/:projectId/plugins`, and `?sessionId=...` scopes a Session. Path and
envelope scopes must agree, and a Session must belong to that Project.

| Interface | Purpose |
| --- | --- |
| `GET /` | Configuration, revision, installation catalog, and capability diagnostics |
| `POST /bridge` | `{apiVersion:1, pluginId, scope, kind, method, input}`; separates queries from commands |
| plugin `query/settings`, Plan `query/state({runId})` | Read-only settings or historical-event projections |
| plugin `command/configure` | `{expectedRevision, settings, fields?, inherit?}`; only changes manifest-declared domain fields |
| `host.settings/command/replace` | `{expectedRevision, overrides}`; saves one complete scope form |
| `GET /events` | Authenticated fetch SSE; `changed` only signals invalidation and the client rereads; disconnect releases the subscription |

A failed CAS comparison returns 409. Cross-scope or invalid input is rejected by the Bridge
error contract. Configuration does not store plaintext credentials; sensitive access keeps
using existing secret and permission ports.

`SessionStore` is the settings authority. Classic `replaceGlobalSettings`,
`replaceProjectSettings`, `replaceSessionSettings`, Composer `updateSession`, Bridge, and
`commitPluginSettings` share a **catalog-level settings mutex**. Global inheritance can
change a Project/Session's effective revision, so it cannot lock only a plugin or HTTP
handler. The lock is acquired before read/compare/rewrite/persist. Stale CAS or invalid
parameters do not block later writes. This is an in-process boundary for one API instance,
not a distributed lock.

Bridge rechecks `expectedRevision` and cancellation under that lock. ApplyPort checks its
baseline and saves settings plus receipt in one SQLite transaction. Classic PUT adds no
required revision and remains last-writer-wins. A successful receipt proves a submission
succeeded then; it does not prevent a user changing settings later. New settings entries
must reuse this boundary rather than keep a private lock.

## 5. Migrated capabilities and current boundaries

| Package / plugin ID | Contributions and reuse path |
| --- | --- |
| `packages/skill` / `skill` | Skill tools, progressive-disclosure/catalog context, state, and selection settings; retains existing Skill catalog/library asset Ports |
| `packages/mcp` / `mcp` | MCP tool contributions, result commit, and settings; retains existing MCP clients, sources, and permission governance |
| `packages/mcp-sources` / `connector.<source-id>` | Manages UniProt, LLM Wiki, and 11 public biomedical sources in one package; each source has its own manifest/factory and shares MCP execution/governance |
| `packages/scheduler` / `scheduler` | Default `task` and other Subagent scheduling tools; reuses existing orchestration rather than making another scheduler |
| `packages/plan` / `plan` | `update_plan`, batch policy, coordinated state/context, and Project Plan display |
| `packages/artifact-json` / `artifact-json` | JSON Artifact Web preview; raw content remains viewable when disabled |

The built-in source catalog contains `uniprot`, `llm-wiki`, `arxiv`, `pubmed`,
`europe-pmc`, `biorxiv`, `medrxiv`, `pdb`, `ensembl`, `reactome`, `clinvar`, `chembl`, and
`geo`. The API starts from an empty registry and registers these only through
`builtinMcpSourcePlugins`, rather than also running legacy built-in composition. An invalid
LLM Wiki configuration skips only that source and records a diagnostic without its URL;
other sources continue to start.

The actual tool set is the intersection of selected sources and plugin configuration: an
MCP capability must be enabled, `connector.<source-id>` must not be disabled, and the
source must be selected for the current run before permission/governance checks apply.
Main Agents, Subagents, reviewers, and candidate comparison share
`filterEnabledMcpSources`. An unselected source is not authorized merely because its plugin
is enabled. Custom MCP services remain managed through the generic MCP plugin and existing
registration path; user input never dynamically imports plugin code.

These packages encapsulate capability contributions and entries, not a claim that all
repository domain logic has migrated. Skill/MCP/scheduling still reuse tool factories from
`packages/workspace`; API domain control-plane work is not all extracted. Existing
permissions, approvals, storage semantics, and default tool names remain. The same
capability cannot be injected from both legacy Workspace-specific composition and new
plugin composition. Existing evolve tools remain host-internal contributions, not
configurable installation plugins.

This work removed private `@sciencediscovery/plugin-*` capability packages. Callers use the
corresponding public capability-package entries while `plugin-sdk` remains. Plugin IDs,
configuration keys, and asset data keep their names, so users do not migrate settings.
Builds, CI packaging, and Recorder source fingerprints use the new capability packages.
Historical summaries are not rewritten; new Runs generate fingerprints from the new build.

`services/api/src/plugins/control.ts` manages the minimum candidate-comparison composition:

1. `POST /candidates` accepts `{expectedRevision,patch}` and replaces only permitted plugin
   configuration and Skill-selection/library assets. It freezes baseline/candidate through
   CAS and does not alter active composition.
2. `prepare` creates ordinary baseline and candidate experimental Sessions, running the
   same task with the original Runner, model, and permissions.
3. `compare` receives both Run IDs, checks completion, task, and frozen configuration, and
   saves the observed comparison. `approve` is a separate management action, not a model's
   automatic decision.
4. `apply` checks asset/configuration drift and atomically saves settings plus an apply
   receipt. Rejection, conflict, or transaction failure does not apply; an already-applied
   request can retry idempotently.

**Experiment retention and cleanup:** `apply`/`reject` do not automatically delete the two
ordinary Sessions made by `prepare`, so users can review tasks, Artifacts, and comparison
evidence. Once no longer needed, users explicitly remove them through existing Session
UI/API subject to existing running-deletion checks. Candidate records retain Session/Run
references; after deletion, those references cannot be assumed fully viewable. There is no
candidate-specific automatic archive or garbage-collection policy.

Comparison fidelity is `observed-runs`, not deterministic task replay. ApplyPort does not
undo external tool effects. Plugin marketplaces, untrusted hot loading, AgentLoop/harness
rewrites, model training, and complete automatic evolution are outside this implementation.

## 6. Adding and maintaining a plugin

1. **Choose capability ownership and contribution surface.** Prefer adding plugin entries,
   configuration, and UI to an existing `packages/<capability>` rather than a parallel
   `plugins/<capability>`. Begin tools, context, state, and batch policy with
   `RuntimeContribution`; use corresponding installation entries for connectors and Web
   views.
2. **Define manifest and Ports.** A separate manifest export declares stable ID,
   dependency/service versions, permissions, configuration fields, and when changes take
   effect. Factories receive only needed domain Ports. Do not expose an entire SessionStore
   or NativeAgent.
3. **Implement lifecycle and state.** `create()` returns contributions and optional
   `start`/`dispose`; all asynchronous work accepts cancellation. State is serializable and
   versioned; commands/capture use consistent boundaries. A context factory declares
   `stateReads` and projects only from StateView.
4. **Wire installation points.** The API registers the manifest in `catalog.ts` and
   injects Ports in `runtime.ts`; platform capabilities can follow UniProt installation.
   Web separately registers in `settings.tsx`, `project-views.tsx`, and
   `artifact-viewers.tsx`. A new contribution type extends the host contract too; a string
   in the manifest is not enough.
5. **Wire builds and release.** The workspace includes `packages/*`. Add `./plugin`,
   `./manifest`, and, when needed, `./web` exports, host dependencies, TypeScript
   configuration, and the lockfile, confirming both API release artifacts and Web bundles
   contain the entry. A plugin entry imports its package's domain code and must not make a
   root-entry cycle through self-reference.
6. **Verify the maintenance contract.** Test missing dependencies, start/stop,
   cancellation/failure cleanup, frozen state projection, configuration inheritance/CAS,
   and main/Subagent/reviewer composition. User journeys should confirm disabling opens no
   new execution path and history remains readable. Run `pnpm typecheck`,
   `pnpm architecture:check`, and affected builds/tests.

Start with the [Plan plugin entry](../../../packages/plan/src/plugin.ts),
[domain implementation](../../../packages/plan/src/index.ts), and
[manifest](../../../packages/plan/src/manifest.ts). Protocol types are in the
[SDK](../../../packages/plugin-sdk/src/index.ts), settings transactions in
[SessionStore](../../../services/api/src/store.ts), and the complete HTTP settings regression
journey in [plugin-settings-journey](../../../test/api/plugin-settings-journey.mjs).
