# Desktop MCP add and enable controls v1

Date: 2026-11-25. Scope: the existing main-branch desktop MCP settings page. This change is independent of the private MCP cards/drawers redesign and reuses existing configuration and import dialogs and APIs.

The Skills-style row-action extension is specified in [v2](desktop-mcp-controls.v2.md).

| Requirement | Behavior |
| --- | --- |
| MCP-CTRL-01 | Place one dark Add server pill in the page header, matching the Skills add control. Its keyboard-accessible dropdown offers Manual entry and Import JSON, including on an empty list. |
| MCP-CTRL-02 | Manual entry opens the existing creation form. Import opens the existing JSON dialog, with both pasting and file upload available there. Preserve previews, limits, cancellation and per-server import outcomes; do not introduce the private redesign's draft workflow. |
| MCP-CTRL-03 | A custom server's list switch and its edit-form checkbox both control the saved server enabled field. Successful writes refresh both representations; editing remains a draft until saved. Failed writes retain the previous saved state and show an error. |
| MCP-CTRL-04 | Session-default selection remains independent of service enablement and connection readiness. Show a separately labelled Default use checkbox for each custom/built-in source. Bulk selection changes only those defaults. Enabling a service must not silently select it, and selecting a default must not start a disabled service. Built-ins do not gain an unsupported service-enable action. |
| MCP-CTRL-05 | Preserve stored credentials, OAuth settings and exact unchanged STDIO argument arrays when toggling enablement. Browser journeys cover both enablement directions, edit/save/reload, refused writes, independent defaults, both add sources, keyboard use, English/Chinese and a smaller window. |

Connection status continues to describe the latest actual check/discovery, not a heartbeat. No backend, schema, dependency or gate-policy change is needed.

For MCP-CTRL-05, row actions wrap below server information when space is limited; keep names, status badges and addresses readable instead of squeezing them behind the controls.
