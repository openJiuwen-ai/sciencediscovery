# Configure the Network Proxy

This guide shows how to register a proxy on the settings page and make an LLM, a web tool, or an MCP server inherit the default, force a direct connection, or use a specified record. For policy resolution and outbound access, see [Network proxy](../explanation/network-proxy.md); for the API fields, see the [REST API reference](../reference/rest-api.md#proxy-configuration).

## Configure the model

A proxy record supports three sources:

| Type | Behavior | Intended use |
|---|---|---|
| `custom_url` | Uses an encrypted `http://`, `https://`, or `socks5://` URL | An enterprise supplies a fixed proxy address or a URL with credentials |
| `environment` | Reads `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (including lowercase forms) from the service process | Containers, systemd, or launch scripts inject a proxy uniformly |
| `system` | Reads the GNOME `gsettings` manual HTTP/HTTPS proxy | A Linux workstation with a desktop configuration |

Module strategies use one of these values:

- `inherit`: inherit the global default; this is the default strategy for LLM, web, and any MCP server not configured individually.
- `none`: connect directly and ignore the process proxy environment variables.
- `proxy:<id>`: select a proxy record from the registry.

The global default can only be `none` or `proxy:<id>`, to avoid recursive inheritance. A proxy record that is still referenced by the global default, a model, web, or an MCP server cannot be deleted; the referencing side must be changed first.

## Web configuration

Open **System configuration**:

1. In **Network proxies**, choose the **Global default** first, then review the proxy server list; to add one, click **Add proxy server** to expand the form.
2. On the same page, select a strategy for WebSearch and for each MCP server. Multiple paper sources may share one Python MCP server, so they are listed together in one row for sources that share that server.
3. In **Model registry**, configure the **LLM proxy** for each model.

The full URL of a `custom_url` record is shown in plain text on the proxy settings page after login and through the Bearer-authenticated proxy settings API, and is prefilled with the current value when edited. Switching a record to `environment` or `system` deletes the old secret.

An `environment` record shows the actual variable names resolved by the service process, the `configured` / `unconfigured` / `invalid` status, and the current effective value. An empty string is treated as unconfigured; a valid URL (including username, password, path, and query) is shown in full on that authenticated settings surface. An invalid URL returns only the reason and does not echo the invalid original value. This projection reflects the environment resolution of the Node control-plane process and is consumed by the LLM, Node fetch, and web outbound paths.

### URL protocols and authentication formats

- Plain HTTP proxy: `http://host:port`, for example `http://proxy.example.test:8080`.
- When the proxy server itself uses TLS: `https://host:port`, for example `https://proxy.example.test:8443`. The target website being HTTPS does not mean the proxy URL must use `https://`.
- SOCKS5 proxy: `socks5://host:port`, for example `socks5://proxy.example.test:1080`. The project currently uses Undici 8.7, whose SOCKS5 support is experimental; `socks5h://` and other unverified protocols are not promised.
- Username/password authentication: `scheme://username:password@host:port`.

When the username or password contains URL-reserved characters such as `@`, `:`, `/`, `#`, `%`, or spaces, they must be percent-encoded first. For example, the username `research@team` and the password `p@ss:word` can be written as:

```text
http://research%40team:p%40ss%3Aword@proxy.example.test:8080
```

The example above is a synthetic format sample only. Do not record real credentials in documentation, command history, logs, or screenshots.
