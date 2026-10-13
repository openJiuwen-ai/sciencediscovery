# Configure the Network Proxy

This guide shows how to register a proxy on the settings page and make an LLM, a web tool, or an MCP server inherit the default, force a direct connection, or use a specified record. For policy resolution and outbound access, see [Network proxy](../developer-docs/network-proxy.md); for the API fields, see the [REST API reference](../reference/rest-api.md#proxy-configuration).

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

1. Open **Network and proxy** and choose environment configuration (default), a specified HTTP/SOCKS5 proxy, or direct connection. Normally leave module policies at **Inherit global default**.
2. Use **Save** or **Save and close** to apply changes. Switching sections preserves drafts, including an unfinished proxy form; **Cancel and close** and the close icon discard unsaved changes. The form's Add/Update buttons only stage entries.
3. **Test connection (without saving)** tests the draft against the download source, not model authentication or every destination. It does not save settings. Stage a new entry first to test it; the footer can save a new form directly.
4. Advanced sections retain named proxy records, WebSearch/MCP overrides and a comma-separated bypass list. Existing model-specific overrides remain compatible in Model registry. Referenced entries cannot be deleted until their references are changed.

Proxy summary cards mask credentials; editing remains available to authenticated administrators. The authenticated settings API still supplies custom URLs to the editor; storage is encrypted. Do not share raw settings responses. Switching a record to `environment` or `system` deletes the old secret.

An environment entry shows the effective variable names and configured/unconfigured/invalid status. Credentials and query parameters are redacted. Lowercase variables take precedence, including an explicitly empty value. HTTP uses HTTP_PROXY then ALL_PROXY; HTTPS uses HTTPS_PROXY then ALL_PROXY. Local platform loopback HTTP/WebSocket traffic stays direct even with a broken outbound proxy.

## Installation, Runner environments and recovery

Before the UI exists, export `HTTP_PROXY` and `HTTPS_PROXY` (or `ALL_PROXY`) in the terminal or service that actually starts installation. A browser's system proxy does not prove the terminal inherited it. Build-time micromamba downloads use those variables; local Runner setup/package installation takes the saved global route on each new operation. Version pins, SHA-256 and TLS checks remain enforced.

Saving does not interrupt an in-flight request. Environment variables belong to a running process: changing them in another terminal requires restarting the relevant service. Remote Runner environment operations also receive the global policy; in environment mode they resolve their own variables, not the API host's. A specified localhost proxy is rejected for remote Runner operations: use an address reachable remotely or the remote process environment. Proxy credentials are not stored in environment artifacts or injected into sandbox code.

An explicit proxy failure never silently falls back to direct access. Check the component/stage and underlying network error, correct the configuration, then retry the failed environment setup. Existing verified tools/caches are reused; there is no requirement to reinstall the application or clear all data. Outbound connectivity is not a startup gate, and proxy configuration does not grant sandbox network permission.

### URL protocols and authentication formats

- Plain HTTP proxy: `http://host:port`, for example `http://proxy.example.test:8080`.
- When the proxy server itself uses TLS: `https://host:port`, for example `https://proxy.example.test:8443`. The target website being HTTPS does not mean the proxy URL must use `https://`.
- SOCKS5 proxy: `socks5://host:port`, for example `socks5://proxy.example.test:1080`. The project currently uses Undici 8.9, whose SOCKS5 support is experimental; `socks5h://` and other unverified protocols are not promised.
- Username/password authentication: `scheme://username:password@host:port`.

When the username or password contains URL-reserved characters such as `@`, `:`, `/`, `#`, `%`, or spaces, they must be percent-encoded first. For example, the username `research@team` and the password `p@ss:word` can be written as:

```text
http://research%40team:p%40ss%3Aword@proxy.example.test:8080
```

The example above is a synthetic format sample only. Do not record real credentials in documentation, command history, logs, or screenshots.
