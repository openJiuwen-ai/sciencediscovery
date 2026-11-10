# Network Proxy Mechanism

ScienceDiscovery provides an instance-level proxy registry and unified policy model. Configuration steps are in [Configure the network proxy](../advanced-setup/configure-network-proxy.md); API fields are in [REST API](../reference/rest-api.md#proxy-configuration).

## Configuration model

| Type | Behavior | Use |
|---|---|---|
| `custom_url` | Encrypted HTTP, HTTPS, or SOCKS5 URL | Fixed enterprise address or credential URL |
| `environment` | Reads uppercase/lowercase HTTP(S)/ALL proxy and NO_PROXY variables | Container, systemd, or launcher injection |
| `system` | Reads manual GNOME `gsettings` HTTP/HTTPS proxy | Configured Linux workstation |

Module policies are `inherit` (LLM/Web/default MCP behavior), `none` (explicit direct access ignoring proxy environment), or `proxy:<id>`. The global default is only `none` or `proxy:<id>` to avoid recursive inheritance. A referenced proxy cannot be deleted until global/model/Web/MCP references change.

## Outbound integration

The Node control plane owns registry, policy, and ciphertext. `SessionStore.resolveProxy(policy)` yields storage-independent `direct`, `environment`, or `{mode:"url",url}`. Node fetch paths use `proxyDispatcher(resolved,targetUrl)` with protocol and NO_PROXY handling; subprocesses use `proxyEnvOverlay`. Logs may record mode/use but never the full URL.

- LLM: Node resolves model policy at run start and projects environment policy against the base URL into final URL/direct. `packages/model/src/client.ts` pins the request-scoped undici dispatcher. Native runs call that client directly; JiuwenSwarm model calls return through the adapter and API model gateway to the same product model layer.
- Web: `WebBroker` resolves the Web policy once per call and hands the resolved result straight to the in-process provider layer, which dispatches through the same shared helper.
- MCP/paper sources: Node resolves independently by `mcpServerId`; built-in stdio servers receive a process-environment overlay. Artifact-byte downloads reuse the server policy and Node dispatcher.

New outbound code should accept `ProxyPolicy`, resolve closest to the request, and use the shared dispatch/environment helpers. The bundled Python MCP servers receive an already resolved environment overlay from Node and never read Node storage.

## Migration, security, and limitations

- Legacy Web settings migrate once into the registry and old ciphertext is removed.
- Custom URLs use the model-token AES-256-GCM key; protect the key with the data directory during backup/migration.
- Custom URLs remain available for editing through the authenticated settings API. Environment summaries mask credentials. Logs, audit, and diagnostic errors must not expose proxy credentials; protect the bearer token and browser session.
- `system` supports only manual GNOME proxying. Headless Linux, PAC/auto, and unreadable `gsettings` fail explicitly rather than silently going direct. Results/failures cache for about 60 seconds.
- Built-in MCP currently uses stdio and environment injection. Future HTTP/SSE MCP clients need explicit proxy integration.
- stdio MCP reads gateway environment rather than a Node-projected environment. Standard `.env` deployment aligns them; nonstandard differing process environments can make UI and MCP egress disagree.
- Managed environment setup, creation and package installation receive the global policy per operation. Runner scopes it with async-local storage and passes it to micromamba downloads and package subprocesses, without changing the process-wide environment. Environment mode resolves on the Runner host. A remote Runner rejects a custom loopback proxy address belonging to the control host. Pinned version, checksum validation, caching and existing retry behavior are preserved.
- `packages/network` provides source-loadable routing and download helpers shared by installation scripts and services. Loopback destinations bypass outbound proxy settings. Adapter HTTP clients initialize environment-aware external transport lazily; internal loopback HTTP and WebSocket connections use explicit direct transport. Python HTTP and WebSocket SOCKS dependencies are declared and locked.
- `POST /api/proxy/test` probes the download source with a draft policy without saving it. It is a user-triggered diagnostic, not an automatic startup gate or proof that every provider is reachable. There is no automatic failover, traffic dashboard, or Project/Session registry override.
- Settings are drafts until the footer saves them. Saving multiple sections uses sequential API requests, not a cross-section transaction; a later failure does not roll back earlier successful writes. Sandbox network authorization remains separate from proxy routing.
