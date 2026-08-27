---
name: skill-creator
description: Create a reviewable reusable Agent Skill draft from a user's explicit natural-language description. Use when the user asks the Agent to create, build, or revise a Skill; do not use merely because a workflow seems reusable.
metadata:
  version: 1.3.0
---

# Skill Creator

Create a focused, portable Skill that preserves the user's stated intent.

## Creation contract

- Act only when the user explicitly asks to create or install a Skill.
- Infer ordinary details from the description. Ask a question only when missing information would materially change the Skill.
- Use a lowercase kebab-case name of at most 64 characters and a concise, discriminating description.
- Treat `name` as the Skill's stable identity, not a proposal title. Every revision or alternative version of one logical Skill must reuse exactly the same name; put labels such as `lite`, `systematic`, `v2`, or `experimental` in `metadata.version`, the description, or the instructions instead of appending them to the name.
- Assume the Agent is already capable. Instructions should contain only useful workflow guidance, non-obvious constraints, and concrete validation criteria.
- Keep simple Skills self-contained. Add UTF-8 resources under `references/`, `scripts/`, or `assets/` only when they have a concrete reusable purpose.
- Packaged scripts are retained as read-only resources by this runtime; they are not automatically installed or executed. Do not promise automatic execution.
- Never include credentials, private conversation details, or unrelated workspace content.

## Workflow

1. Translate the user's description into one stable Skill name, selection description, Markdown instructions, and optional version/resources.
2. Check that the instructions preserve authorization boundaries and do not generalize a one-off preference into a universal rule.
3. Normally call `create_skill` exactly once with the complete proposed package. If the user explicitly requests multiple versions or alternatives of the same Skill, call it once per requested version in order and reuse the exact same `name` every time; each later call updates that draft and becomes another comparable proposal in its version history.
4. A matching managed Skill name creates a draft based on its current revision; a matching unconfirmed draft is updated in place and compared with the previous Agent proposal; built-in Skills remain read-only.
5. Report one pending Skill and direct the user to its review action in the conversation or Settings > Skills. The draft is inactive until the user explicitly confirms it.

If draft creation reports a read-only name or validation error, stop and explain the correction needed. Do not rename or retry without the user's direction.
