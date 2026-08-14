# Configure the Network Proxy

This how-to explains how to register a proxy on the settings page and let the LLM, Web tools, or MCP server inherit the global default, force a direct connection, or use a specific record. For policy resolution and outbound integration internals, see [Network proxy](../explanation/network-proxy.md); for API fields, see [REST API reference](../reference/rest-api.md#proxy-configuration).

## Configuration model

Proxy records support three sources:

| Type | Behavior | Use |
|---|---|---|
| `custom_url` | Uses an encrypted `http://`, `https://`, or `socks5://` URL | Enterprise provides a fixed proxy address or a credential-bearing URL |
| `environment` | Reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (lowercase forms included) from the service process | Container, systemd, or launcher injects the proxy uniformly |
| `system` | Reads the GNOME `gsettings` manual HTTP/HTTPS proxy | Linux workstation with a desktop configuration |

Module policies use these values:

- `inherit`: inherit the global default; this is the default policy for the LLM, Web, and any MCP server not configured separately.
- `none`: explicit direct connection, ignoring process proxy environment variables.
- `proxy:<id>`: select a proxy record from the registry.

The global default can only be `none` or `proxy:<id>`, to avoid recursive inheritance. A proxy record still referenced by the global default, a model, Web, or an MCP server cannot be deleted until the referencing party is changed.

## Web configuration

Open **System configuration**:

1. Under **Network proxies**, first choose the **Global default**, then review the proxy server list; to add one, click **Add proxy server** to expand the form.
2. On the same page, choose a policy for WebSearch and for each MCP server. Several paper sources may share one Python MCP server, so they are listed together on one row for sources sharing that server.
3. Under **Model registry**, configure the **LLM proxy** for each model.

The full URL of a `custom_url` is shown in plain text on the signed-in proxy settings page and the bearer-authenticated proxy settings API, and is prefilled when editing. Switching a record to `environment` or `system` deletes the old ciphertext.

An `environment` record shows the variable names the service process actually resolves, the `configured` / `unconfigured` / `invalid` status, and the current effective value. Empty strings are treated as unconfigured; valid URLs (including username, password, path, and query) are shown in full on that authenticated settings view. An invalid URL returns only the reason, without echoing the invalid original value. This projection reflects the Node control-plane process environment resolution, consumed by the LLM, Node fetch, and Web egress.

### URL protocols and auth format

- Plain HTTP proxy: `http://host:port`, for example `http://proxy.example.test:8080`.
- When the proxy server itself uses TLS: `https://host:port`, for example `https://proxy.example.test:8443`. The target site being HTTPS does not mean the proxy URL must use `https://`.
- SOCKS5 proxy: `socks5://host:port`, for example `socks5://proxy.example.test:1080`. The project's current Undici 8.7 support for SOCKS5 is experimental; `socks5h://` and other unverified protocols are not promised.
- Username/password auth: `scheme://username:password@host:port`.

When the username or password contains URL-reserved characters such as `@`, `:`, `/`, `#`, `%`, or spaces, percent-encode them first. For example, username `research@team` and password `p@ss:word` can be written as:

```text
http://research%40team:p%40ss%3Aword@proxy.example.test:8080
```

The above is a synthetic format example. Never record real credentials in documentation, command history, logs, or screenshots.
