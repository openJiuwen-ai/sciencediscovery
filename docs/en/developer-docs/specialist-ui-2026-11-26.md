# Specialist management UI — 2026-11-26

## Design source and scope

The user-provided `skill_mcp_专家.zip` (SHA-256
`8bae486a20e63b83402aa59af22d4eb38f9ab39f207245b6898111af0ea5e7bc`),
`专家管理` frames, supersedes the 2026-11-25 row/modal presentation.
The user explicitly selected Specialist management only; Skills and MCP pages
are references, not additional implementation targets. Prior UI versions remain
in Git history. Existing prompt composition and runtime permissions are preserved.

## Requirements and acceptance

- **SPUI-01 Catalog:** responsive three/two/one-column cards, initial-letter
  coloured marks, source and capability badges, All/My/Official tabs with counts,
  search by name/description, bulk enable/disable, and a dark Add specialist action.
  Cards open details; their switch and overflow button do not open details.
  The fixed Reviewer remains separately identified and outside bulk operations.
- **SPUI-02 Actions:** overflow menus follow the new vertical-dot design.
  Both sources offer Try; disabled roles cannot start a new conversation.
  Only custom roles offer Delete. Edit is in the custom role's detail header.
  Built-ins cannot be edited or deleted. Deletion confirms, reports server
  failures, and returns from deleted details to the refreshed catalog.
- **SPUI-03 Editor:** creation and editing are full subpages with Back and a
  sticky Cancel/Save footer. Fields are name, description, instructions, runtime,
  capability mode, separate collapsible skill/MCP selections, and optional prompt
  examples. Keep existing 80/500/20,000 input limits: the reference's 1,000
  instruction counter must not truncate existing valid instructions.
  Save failure retains the complete draft and offers retry.
- **SPUI-04 Capability drawer:** independent Skills/MCP drawers with source tabs,
  search, card checkboxes, selected count and Cancel/Confirm. Only Confirm updates
  the parent draft. Missing selected IDs remain visible and explicitly removable.
  Bundled skills that failed to load are unavailable. The Skills drawer excludes
  them and removes any saved failed selections when confirmed.
  The existing API represents empty capability lists as inheritance; therefore
  Specific mode requires at least one selection rather than silently broadening
  an empty selection to all capabilities.
- **SPUI-05 Details and Try:** detail subpages show all instructions, runtime,
  capability names and prompt examples. Try opens a new inbox conversation bound
  to the enabled role; an example pre-fills the composer once for the user's review.
  The session creation API refuses a new binding if the role has been disabled
  since selection.
  Neither action submits a Run or calls a model automatically. Existing sessions
  and their drafts are not rebound or submitted.
- **SPUI-06 Prompt examples:** optional persisted `promptExamples: string[]` on
  Specialist/create/update, up to ten nonempty examples of at most 1,000 characters
  each. Omitted values read as empty; edits preserve them; built-ins stay read-only.
  They are UI suggestions, never part of the system instructions automatically.
- **SPUI-07 Compatibility:** retain enabled persistence, partial bulk reload,
  unavailable-skill repair, and truthful disabled current bindings. Scope all new
  styles to Specialist surfaces; the Skills/MCP managers retain their current UI.

## Verification

Cover bilingual catalog filters/search, create/edit/detail, drawer apply/cancel,
prompt-example persistence, error/retry, disabled Try, read-only built-ins,
pointer-confirmed deletion, and a new bound conversation with a pre-filled draft
and no Run. Use isolated actual API journeys plus deterministic browser fixtures,
including 1920×1080, 1440×900 and 960×720, DPR 1. Check long names, missing
capabilities and full instruction text. Record immutable source and screenshot
provenance; old review approvals and images do not certify this redesign.
