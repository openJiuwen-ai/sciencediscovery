# Configure custom MCP servers, OAuth and Inspector

[中文](../../zh/advanced-setup/configure-custom-mcp.md) | [REST API](../reference/rest-api.md)

This guide covers custom MCP management in system settings. On desktop, All MCP, My MCP and Official MCP tabs filter the catalog; built-in sources do not need to be added again. Search matches names and descriptions.

> **Release availability:** Custom MCP server management is available in 0.3.0-beta and later builds. It is not included in the 0.2.0 release: that version has neither the **MCP servers** settings page nor the `/api/mcp/servers` routes described below. Upgrade before following this guide.

## Before you start

- Start the product, open its regular Web address, and connect using the local service access token from `<data-dir>/secrets/auth-token` or your configured `SCIENCE_AGENT_AUTH_TOKEN`. The printed sign-in URL is optional.
- Obtain the MCP provider's startup command or remote MCP URL and authentication requirements. An MCP URL is not an ordinary web page or an OpenAI-compatible LLM base URL.
- STDIO runs on the API backend machine, not the browser machine, and does not automatically enter the Session sandbox. Configure only trusted commands and install the required runtime there. With Docker, executable paths and dependencies must be available inside the container.

## Add and manage a server

1. In the desktop UI, open **Settings → MCP servers → Add MCP server → Manual entry** using the dark header menu. In the Web UI, open system settings, select **MCP servers → Custom**, and choose **Add server**.
2. Enter a name and optional description, select a transport, and complete its fields.
3. Set **Tool timeout (seconds)**. The default is 60, with an allowed integer range of 1-600. This timeout cannot be disabled.
4. The **Enable service** switch at the bottom of the desktop create/edit form controls the entire server and starts off for a new configuration. The custom card, details and edit switches update the same saved value. **Use by default** is a separate switch in details: selecting a default does not enable a disabled server. **Enable all / Disable all** affect only currently visible custom servers and do not change session defaults. Built-in card switches control default selection, not service enablement. The Web UI retains its own list enable control.
5. On desktop, choose **Confirm add** to save; the dialog closes and a single-server creation checks the connection. A failed check does not undo the saved configuration. Use **Test** on the card or in its details footer to retry. Click a card to read configuration and tools or manage OAuth. Its **⋮** menu offers **Try it**, **Edit** and **Delete**; built-in menus offer only **Try it**. Try it opens a new conversation with this source and the current model, without sending a message or granting extra permission. In the Web UI, expand the server and select **Test connection** to inspect discovered tools, descriptions and input schemas.

| Transport | Fields |
|---|---|
| STDIO | Executable in Command; one argument per line in Arguments; optional working directory and environment variables |
| Streamable HTTP | Provider's MCP URL and its required request headers or OAuth settings |
| SSE | Provider's SSE endpoint and its required request headers or OAuth settings |

For a server started by `node /opt/research-mcp/server.mjs`, enter the backend's `node` executable path in Command and `/opt/research-mcp/server.mjs` as one Arguments line. This is an illustrative path, not a bundled service. Do not enter an entire shell command in Command.

Testing a disabled server does not enable it, but STDIO testing does start the configured program. Deleting a server removes its configuration, connector references and local authorization; it does not uninstall the program.

### Import JSON

On desktop, choose **Add MCP server → Import JSON**. Paste JSON or choose **Upload JSON file** to read UTF-8 JSON (BOM accepted, maximum 1.5 MB). JSON fills the ordinary editable configuration form; for multiple servers, switch between their configurations to review each one. Choose **Confirm add** or **Add N servers** to save them through the normal per-server save route. Selecting a file or editing JSON alone saves nothing. Text editing keeps its caret in the JSON editor; file upload moves focus to the filled form. There is no separate import-preview confirmation or Done step. The Web UI retains **Import JSON**. Provide a `mcpServers` object, for example:

```json
{
  "mcpServers": {
    "Research MCP": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "timeoutSeconds": 60
    }
  }
}
```

Replace the placeholder URL with the actual endpoint. Desktop imports each server separately and shows each outcome, retaining successful entries; a single Web/API batch request validates its whole batch before saving. Imported entries are disabled until you enable them. Duplicate names are rejected; at most 50 custom servers can be saved. Invalid or unreadable files show an error; edit the text or select the file again. Never include real credentials in public issues, screenshots or shared configurations.

## Secret request headers and environment variables

For HTTP/SSE, select **None / request headers** and add headers such as `Authorization` as required by the provider. STDIO accepts environment variables. Values are encrypted on the backend; reopening the editor shows **Saved value**, not plaintext.

- Leaving a saved key and value unchanged retains the secret.
- Renaming a saved key requires re-entering its value; saving is blocked until you do so. The old secret is not automatically copied to the new name.
- If you only changed the key, restoring its original name retains the saved value without re-entry.
- Explicitly editing and clearing a value without renaming the key saves an empty string, rather than retaining the old value. Removing the row removes that entry.

For direct API clients, `null` retains a value only under the exact same key. See [REST API](../reference/rest-api.md) for replacement and deletion semantics. This fix cannot recover credentials already cleared by an older version; obtain and enter them again from their original provider.

## Sign in with OAuth

OAuth applies to HTTP/SSE, not STDIO. Remote OAuth endpoints require HTTPS; loopback HTTP is allowed for development.

1. Select **OAuth** under Authentication and remove any manually configured Authorization header.
2. Supply Client ID, Client Secret and Scope as required by the provider. Leave Client ID empty only when the provider supports an appropriate registration flow. A nonempty Client Secret requires a Client ID.
3. If using a client metadata URL, provide an accessible HTTPS metadata document. The product accepts the URL but does not host that document for you.
4. Check the displayed callback URL and, when required, register that exact address with the provider. `localhost`, `127.0.0.1`, different domains and ports are not interchangeable.
5. Save, then choose **Sign in** in server details and complete consent in the new window. If the popup is blocked, use **Open login page**.
6. Return to the product, check the authorization state, and test discovery and tool execution. You can sign in again or cancel a pending attempt.

Tokens are stored and refreshed by the backend. Do not paste them into the local service access token field or manually copy them to request headers. Invalid refresh tokens, insufficient scope or configuration changes may require another sign-in. **Clear local authorization** removes this product's saved credentials, not consent at the provider; revoke provider-side access in the provider's own settings.

Registration policies, scopes, callback allowlists and account permissions differ between providers. OAuth support does not imply universal zero-configuration compatibility.

## Test tools with Inspector

The following Inspector workflow is available in the Web UI. Desktop details provide the tool preview; use **Try it** to open a conversation for agent-driven calls.

1. Open a Session in a Project, enable the MCP server and discover its tools with Test connection.
2. Expand its details and open **MCP Inspector**. Check the associated Session.
3. Select a tool, inspect its description and input schema, then fill in the JSON arguments.
4. Execute and inspect success/failure, duration, raw response and normalized result. Copy the result or expand and copy the invocation record ID.
5. While running, you can cancel waiting and invoke again later. Cancellation cannot guarantee reversal of side effects already performed remotely.

Inspector performs real tool calls, not simulations, and does not call an LLM to fill arguments. Understand whether a tool writes or deletes data before executing it. A Session is required for the existing invocation audit chain; execution is unavailable without one or while the server is disabled. This tools-focused UI is not a full embedding of the official standalone Inspector and does not provide a complete resources/prompts browser.

## Allow the Agent to use tools

Enable the MCP in the target Session's connector selection. Global server enablement and the Session's effective connector selection are separate requirements. A Session may inherit Project/global settings; inspect its effective selection rather than assuming every Session starts with an empty list.

The Agent decides whether a task needs a tool, so selection does not force a call on every message. Manual Inspector execution does not change the Session's connector selection or authorize its Agent to use every tool.

## Rollback to an older build

An ordinary save that does not record a configuration operation leaves `<data-dir>/custom-mcp-servers.enc` as a plain map of `custom-<12 hex>` server entries. Older builds can read that file.

The first journaled MCP settings change rewrites the file as an encrypted v2 envelope (`sciencediscovery-custom-mcp-v2`). The first deletion rewrites it as v3 (`sciencediscovery-custom-mcp-v3`). After that first deletion the store keeps the newer format permanently, even when no deletion is still pending. Older builds cannot read either envelope: loading the file fails and the API does not start.

There is no automatic downgrade. To run an older build again, restore the pre-upgrade `custom-mcp-servers.enc` file, or start from an empty store and add the servers again.

## Troubleshooting

| Symptom | Check |
|---|---|
| Connection guide opens or shows Unauthorized | The local service access token, not the MCP provider token or external model API Key; paste the current token from `<data-dir>/secrets/auth-token` or the configured `SCIENCE_AGENT_AUTH_TOKEN` into Connection |
| STDIO cannot start | Executable, arguments, working directory and dependencies on the backend machine/container |
| HTTP/SSE authentication failure | MCP URL, header names/values, OAuth state and provider permissions |
| Save blocked after renaming a key | Re-enter the value, or restore the original key if the value was not edited |
| OAuth callback fails | Application origin and registered callback match; authorization has not expired or been cancelled |
| Connection succeeds but a tool fails | Input schema, scope, tool permissions and timeout; discovery does not prove every tool can execute |

For network routing, see [Configure the network proxy](configure-network-proxy.md).
