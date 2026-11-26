# Desktop MCP controls v2 — row actions

Date: 2026-11-25. Extends [v1](desktop-mcp-controls.v1.md) following the request to match the Skills row menu. The add dropdown and service/default state requirements in v1 remain in force.

| Requirement | Behavior |
| --- | --- |
| MCP-CTRL-06 | Replace the custom MCP row's inline Tools, Test, Edit and Delete links with the same chevron, icon menu, hover treatment and separated red destructive action used by Skills. Share the menu primitive; preserve Skills export/edit/delete permissions and behavior. |
| MCP-CTRL-07 | Keep the labelled default-use checkbox and the service-enable switch outside the action menu. Keep all OAuth authorization, cancel, open-page fallback and clear-grant actions available in the menu when applicable. Built-in sources retain their supported default-use control. |
| MCP-CTRL-08 | Mouse hover/click, touch and keyboard can reach every action. Escape dismisses only the menu and returns focus to its trigger. Busy and unavailable actions remain disabled; menus fit above or below the row and scroll when needed. Preserve connection testing, editing, deletion confirmation, failure recovery and unsaved cancellation. |

Acceptance: desktop unit tests protect Skills and MCP action availability; browser journeys exercise the menu and both enable controls, import, edit, connection testing and cancel/confirm deletion. Inspect actual English/Chinese menu screenshots at regular and smaller desktop sizes. Reuse isolated test dependencies and keep all evidence outside user data.

Keyboard acceptance for MCP-CTRL-08: after clicking the trigger, focus may remain on that trigger while the menu is already open. ArrowUp must enter at the last enabled item and ArrowDown at the first; subsequent presses wrap through enabled items.

Visual acceptance for MCP-CTRL-06/07: the pending-authorization open-page link uses the same plain menu-item typography and hover treatment as button actions, without a link underline. Include the authorizing state in both screenshot languages while preserving its external-link semantics.

The latest MCP layout and PR scope are specified in [v3](desktop-mcp-controls.v3.md).
