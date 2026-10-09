# Idea Tree autonomous-research engine

Idea Tree runs inside the existing evolve Python service through an ASGI worker. The
API handles session authentication, model proxying, and usage recording; Python runs
the research loop; and the existing Web tree panel starts, observes, and controls it.
The chat Agent does not run the tree workflow, create an execution plan, or dispatch
Subagents.

## Use

In **System settings** → **Idea Tree**, configure the default budget and role prompts.
Then enter `/idea-tree <research task>` or `/idea-tree-team <research task>` in a
session to start it. The frontend has no separate form for an objective, source text,
or files. `objective` and `materials` remain backend inputs for creating research.
Complete retrieval and parsing before starting: the engine has no external retrieval,
code-execution, or tool capability. The workspace tree panel shows running state,
pause, resume, stop, and node details without opening a separate dialog.

One round consists of a batch of candidates, individual design and assessment, and
feedback. By default, a research run has at most three rounds with at most three
candidates in each. Candidate count, node count, and depth limits also apply. Maximum
depth is a limit, so shallower candidates can still be assessed. Later rounds use
existing insights to explore new directions or improve existing candidates. At the
depth limit, the engine can create a sibling improvement.

You can replace the design, three assessment, aggregation, and propagation role prompts
in **System settings**. Changes apply to new research. The backend manages ideation
prompts and does not expose an additional editor for them. Default scoring retains
activity, stability, and sustainability dimensions, and Python calculates the weighted
score.

Pausing does not cancel a model request that has already been sent. The panel first
shows **Pausing**, then **Paused** after the in-flight response finishes. The in-flight
call can still incur usage, but it does not start the next stage. Resuming always
requires an explicit user action. After a process restart, research is **Interrupted**
and does not resume automatically. Stopping requires confirmation, retains existing
results, and cannot be reversed by resuming.

## Implementation and state

- `vendor/idea_tree/research.py`: ideation, design, independent assessment,
  aggregation, and level-by-level propagation. It saves each completed stage and runs
  only unfinished stages after recovery.
- `vendor/idea_tree/research_tree.py`: reuses node and ancestor queries from the root
  `tree.py`.
- `vendor/idea_tree/prompts.py`: role instructions and scoring criteria.
- `vendor/idea_tree/research_service.py`: create, query, pause, resume, and stop. It
  ensures that each session runs at most one research job in a process.
- `services/api/src/idea-tree/research.ts`: research HTTP client and temporary model
  proxy credentials.
- `apps/web/src/IdeaResearchPanel.tsx`: research controls in the existing tree panel.

The only persistent state is
`$SCIENCE_AGENT_DATA_DIR/idea-research/<projectId>/<sessionId>/<researchId>.json` in
the Python service, saved through atomic replacement. It includes materials, budget,
nodes, stage results, and usage, but not model credentials. This path does not use
external revisions, leases, `childDigest`, SHA verification, or result handles. The old
tree remains viewable through its existing read API. Its write operations return a
read-only error and its prior execution state is not migrated automatically.

The public endpoint is `POST /api/sessions/:sessionId/idea-tree/research`, where
`operation` accepts `create`, `get`, `list`, `pause`, `continue`, `end`, and `defaults`.
`GET` on the same path lists research. Sending an Idea Tree command directly to the
chat-message API returns a 409 that directs the caller to the research entry point; it
does not start Lead silently.

## Boundaries

Idea Tree currently uses the session's OpenAI-compatible model through the API's model
proxy. When the API or model is unavailable, research is saved as interrupted and can
resume only after those services are available again. Model output must be JSON, with at
most one correction for each formatting error. Network timeouts are not retried
automatically. Model requests use the proxy's roughly 20-minute limit.

An optional total-token budget relies on usage reported by the provider. Before a
request, the service conservatively reserves input and output tokens by UTF-8 byte
count, so it can pause early. This is not an exact billing limit. When a provider does
not report usage, the display is unknown and research with a total budget is
interrupted. Materials and each stage's output have length limits. Ideation carries only
direction summaries plus recent and stronger candidates, not the chat history.

Research scores and material recommendations are model assessments. Do not treat them
as experimental conclusions without experiments or supplied evidence.
