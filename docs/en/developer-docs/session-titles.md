# Automatic Session titles

The first Run names an untitled Session in two stages. A short first message
can serve as the provisional title. A long or empty message uses a neutral
`Session MM-DD HH:mm` title instead of a cut-off sentence. Background naming
then asks the selected model to summarize the first message's core topic or
intent in the user's language. Later messages do not rename the Session, and
compare-and-set prevents an in-flight naming result from replacing a manual edit.

## Generation policy

- Chinese, Japanese and Korean: target 8–16 Unicode characters; maximum 24,
  including spaces and Latin names. A first message containing CJK script uses
  this budget, including mixed scientific names such as TP53.
- English and other languages: target 3–6 words; maximum 8 whitespace-separated
  words and 80 Unicode characters. These are product choices, not competitor limits.
- Return a complete descriptive phrase. Prefer the core topic over an exhaustive
  list of requested steps. Do not cut off a phrase or append an ellipsis.
- Remove reasoning blocks, including nested or unclosed `<think>` blocks,
  before accepting visible content. Separate provider reasoning is never a title.
- If the result exceeds its budget, contains an ellipsis, or the provider reports
  truncation, ask once more for a shorter complete summary of the original message.
  Account for usage from both successful responses. A still-invalid or empty
  result fails refinement and retains the provisional title.
- Store the accepted phrase intact. Sidebar CSS handles width with
  `text-overflow: ellipsis`; the label's `title` attribute exposes the full phrase.
  No data migration changes existing titles or user-authored titles.

## Acceptance examples

| Input or model behavior | Expected result |
| --- | --- |
| Long Chinese request about TP53, immune environment and treatment cohorts | A complete summary such as `TP53表达与治疗响应` |
| Long English request comparing cohorts and proposing validation experiments | `TP53 expression and treatment response`, stored intact even though it exceeds 24 characters |
| Oversized Chinese or English model title | A second generation, never a sliced prefix |
| `TP53 cohort analysis…` | Regenerate; merely deleting the ellipsis is insufficient |
| `<think>outer<think>inner</think>secret</think>TP53 analysis` | `TP53 analysis` |
| Reasoning only, failed request or a second oversized response | Retain the safe provisional title |
| Narrow sidebar, then reload | Same complete persisted title and full-title tooltip; visual clipping only |

The unit suite covers budgets, retries, usage and reasoning removal. The mocked
browser journey `test/journey-session-titles.spec.ts` covers first submission,
persisted naming, safe fallback, reload and sidebar styling. Mock outputs verify
the contract; they do not establish real-model semantic quality.

## Comparison evidence

Reviewed on 2026-10-15. These are public documentation/source observations,
not a live UI experiment or evidence about closed-source internals.

- [Open WebUI's default prompt](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/config.py)
  asks for the main theme, prefers 2–4 words, uses the chat's primary language,
  and requests a JSON title. Its
  [sidebar component](https://github.com/open-webui/open-webui/blob/main/src/lib/components/layout/Sidebar/ChatItem.svelte)
  renders the title with CSS truncation and passes the full title to a hover
  preview. This supports separating title generation from width-dependent display.
- [LibreChat's documented title prompt](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint#titleprompt)
  asks for a title in the detected language with five words or fewer; its title
  model and prompt are configurable. The documentation does not establish a
  server-side regeneration policy for overlong results.
- [Claude's help page](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation)
  documents sidebar access and manual renaming. It does not disclose generation
  length budgets, prompts or overflow handling. We do not infer those internals.

None of these sources establishes reliable automatic enforcement of our proposed
budgets. Explicit validation and one bounded regeneration are ScienceDiscovery's
own policy. Real-model quality evaluation remains separate from deterministic
regression coverage.
