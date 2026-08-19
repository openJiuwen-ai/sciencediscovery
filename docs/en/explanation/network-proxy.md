# Network Proxy Mechanism

ScienceDiscovery provides an instance-level proxy registry and unified policy model. Configuration steps are in [Configure the network proxy](../how-to/configure-network-proxy.md); API fields are in [REST API](../reference/rest-api.md#proxy-configuration).

## Configuration model

| Type | Behavior | Use |
|---|---|---|
| `custom_url` | Encrypted HTTP, HTTPS, or SOCKS5 URL | Fixed enterprise address or credential URL |
| `environment` | Reads uppercase/lowercase HTTP(S)/ALL proxy and NO_PROXY variables | Container, systemd, or launcher injection |
| `system` | Reads manual GNOME `gsettings` HTTP/HTTPS proxy | Configured Linux workstation |

Module policies are `inherit` (LLM/Web/default MCP behavior), `none` (explicit direct access ignoring proxy environment), or `proxy:<id>`. The global default is only `none` or `proxy:<id>` to avoid recursive inheritance. A referenced proxy cannot be deleted until global/model/Web/MCP references change.

## Outbound integration

The Node control plane owns registry, policy, and ciphertext. `SessionStore.resolveProxy(policy)` yields storage-independent `direct`, `environment`, or `{mode:"url",url}`. Node fetch paths use `proxyDispatcher(resolved,targetUrl)` with protocol and NO_PROXY handling; subprocesses use `proxyEnvOverlay`. Logs may record mode/use but never the full URL.

- LLM: Node resolves model policy at run start and projects environment policy against the base URL into final URL/direct, then pins a request-scoped undici dispatcher in `native-agent/model-client.ts`.
- Web: `WebBroker` resolves the Web policy once per call and hands the resolved result straight to the in-process provider layer, which dispatches through the same shared helper.
- MCP/paper sources: Node resolves independently by `mcpServerId`; built-in stdio servers receive a process-environment overlay. Artifact-byte downloads reuse the server policy and Node dispatcher.

New outbound code should accept `ProxyPolicy`, resolve closest to the request, and use the shared dispatch/environment helpers. The bundled Python MCP servers receive an already resolved environment overlay from Node and never read Node storage.

## Migration, security, and limitations

- Legacy Web settings migrate once into the registry and old ciphertext is removed.
- Custom URLs use the model-token AES-256-GCM key; protect the key with the data directory during backup/migration.
- Full custom/environment values appear only through the authenticated settings API/UI. Logs, audit, errors, and other APIs must not expose them; protect the bearer token and browser session.
- `system` supports only manual GNOME proxying. Headless Linux, PAC/auto, and unreadable `gsettings` fail explicitly rather than silently going direct. Results/failures cache for about 60 seconds.
- Built-in MCP currently uses stdio and environment injection. Future HTTP/SSE MCP clients need explicit proxy integration.
- stdio MCP reads gateway environment rather than a Node-projected environment. Standard `.env` deployment aligns them; nonstandard differing process environments can make UI and MCP egress disagree.
- There is no proxy health check, failover, traffic dashboard, or Project/Session registry override.
