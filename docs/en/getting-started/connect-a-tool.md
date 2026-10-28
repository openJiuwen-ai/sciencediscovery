# Connect a tool

Add an external MCP server, check that its tools respond, enable it for one Session, and use it in a task. The round trip is the same for any MCP server; this lesson uses one that needs no installation, account or key.

- **Time:** about 15 minutes. The run itself usually takes a few minutes.
- **You need:** a working task model, and network access from the machine that runs ScienceDiscovery to `mcp.deepwiki.com`.
- **Input:** no file. The prompt asks about the public `scipy/scipy` repository, whose `tukey_hsd` you used in [Analyze a dataset](analyze-a-dataset.md).
- **Connector:** DeepWiki, a free public MCP server that answers questions about public GitHub repositories over Streamable HTTP.
- **You end with:** a DeepWiki entry under **MCP servers**, and `tukey-hsd-notes.md` among the Artifacts.

DeepWiki is a third-party service: the questions the Agent sends go to it, and its answers are generated summaries of the code. Send it nothing private. For servers that need credentials, OAuth or a local command, see [Configure custom MCP servers](../advanced-setup/configure-custom-mcp.md).

## 1. Add the server

Open **System configuration → MCP servers → Custom** and choose **Add server**:

| Field | Value |
| --- | --- |
| Name | `DeepWiki` |
| Transport | Streamable HTTP |
| URL | `https://mcp.deepwiki.com/mcp` |
| Authentication | None / request headers, with no headers |

Tick **Enable this MCP server** at the top of the form and select **Save**. A new server is disabled until you enable it.

Instead of filling the form, you can choose **Import JSON** and paste the snippet below; imported servers start disabled, so enable it in the list afterwards.

```json
{
  "mcpServers": {
    "DeepWiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp"
    }
  }
}
```

## 2. Test the connection

Click the server name to expand it and select **Test connection**. The status changes to **Connected** and the server lists three tools for reading a repository's wiki and asking questions about it. Open a tool to see its description and input schema.

If the test fails, read the error: an unreachable host is a network or proxy issue on the machine that runs ScienceDiscovery, not a problem with the model. [Configure the network proxy](../advanced-setup/configure-network-proxy.md) covers proxies.

## 3. Enable it for a Session

Enabling the server in settings does not give every Session its tools. Create a Project, for example `connect-a-tool`, open its Session, open **Data connectors** in the bar under the message box, and turn on **DeepWiki** under **Custom MCP**.

## 4. Send the task

```text
Use the DeepWiki connector to look at the scipy/scipy repository on GitHub.

1. Find where scipy.stats.tukey_hsd is implemented and which distribution it uses for its p-values and confidence intervals.
2. Note what it assumes about the groups, such as equal variances or equal sample sizes.
3. Write tukey-hsd-notes.md with a short explanation, the source file paths DeepWiki reported, and a caveat that DeepWiki's answers are generated summaries to be checked against the code.

Declare tukey-hsd-notes.md as an artifact and name it in your final reply.
```

The first call to each DeepWiki tool pauses on a **Permission required** card that names the tool, for example one ending in `ask_question`. Choose **Allow same type** for each, and approve the code execution that writes the file.

## 5. What you should see

- Tool calls to the DeepWiki tools in the timeline. Expand one to see the question the Agent sent and the answer DeepWiki returned.
- `tukey-hsd-notes.md` among the Artifacts, with the implementation file and the distribution DeepWiki reported, notes on the assumptions, and the caveat you asked for.
- No change in other Sessions: they do not see DeepWiki until you turn it on there.

Different runs may ask different questions and phrase the notes differently. What matters is that the answer came from the connector and that the note says where it came from.

## 6. Check your result

- [ ] **MCP servers → Custom** shows DeepWiki as **Connected**.
- [ ] The timeline contains DeepWiki tool calls that you approved.
- [ ] `tukey-hsd-notes.md` is listed among the Artifacts and names the source files it relied on.

To try a tool by hand without the Agent, expand the server and open **MCP Inspector**; it makes real calls and records them against the Session you choose. See [Configure custom MCP servers](../advanced-setup/configure-custom-mcp.md#test-tools-with-inspector).

## Next

Continue with [Trace a result](trace-a-result.md).
