# Session trajectory and model context

The **Trajectory** entry beside a Session title opens a read-only viewer. It places
execution by main Agents and Subagents on one real-time axis and provides node details and
NDJSON export.

## Using the viewer

1. After running a task, select **Trajectory** beside the Session title to replace the
   current Session conversation with its read-only trajectory view. It is not a dialog.
   The session entry becomes **Conversation**; that entry, the viewer's close button, and
   Escape all return to the conversation. The viewer does not subscribe to streaming
   model output. Refresh reads newly published records, and model output shows only the
   final completed response. The URL path
   `/projects/<id>/sessions/<id>/trajectory` preserves the view across refresh and browser
   navigation. Older `?trajectory=open` links remain readable and normalize to the path.
2. The upper timeline always shows every Agent and ignores the filters below. Its Agent
   label column stays fixed and its horizontal scroll bar stays visible above the tracks.
   Ctrl-scroll zooms around the pointer without changing row structure. Timeline height
   and the event-list width are resizable, including with arrow keys. Below it, select one
   Agent, then one or more event types. The default is the main Agent grouped by Run.
   Selecting another Agent's timeline mark updates the lower selection and locates that
   event. Model work and tool/MCP activity have separate rows.
3. Details retain **Event content** and **Agent state**. Model-input content is the fixed
   input for that invocation. Other entries show reasoning, final output, or tool
   parameters/results. When an exact association exists, **View this input** locates the
   associated input. Assembly diagnostics remain in the API and export rather than a
   separate viewer tab.
4. Inputs have two areas: system prompt and messages retain their actual order; tool
   definitions come from the separate `tools` field in a collapsible list. The navigation
   uses recorded roles, contribution metadata, or unique call IDs, never guesses from
   body text. It initially locates the newest message and can jump to the system prompt,
   first message, or newest message.
5. NDJSON exports trajectory evidence. They can contain sensitive conversation and tool
   result content, so handle them accordingly.
6. The viewer shows only model input, final output, reasoning, tools, and MCP. It hides
   lifecycle categories such as run start/finish/failure/cancellation, recovery, and
   Subagent notifications. Hiding changes presentation only: original evidence remains in
   the export and Agent state remains available in details. A Run is one Agent execution,
   `turn` is a round within that Run, and `#` is the event-stream sequence.
7. The detail pane starts with **Event content** and can switch to **Raw JSON**. A model
   input's raw view is the same fixed `ModelContextSnapshot.input`; it does not mix in
   assembly process or current state. Unknown structures retain their JSON rather than
   guessing text.
8. Each request has one **Model response** node containing its text, usage, and tool-call
   declaration. Unfinished requests and historical records without a final response do
   not manufacture one from partial text. Missing usage is labelled **Not recorded**, not
   treated as zero.

## Components and data flow

```text
NativeAgent / AgentVersionRecorder ── existing SessionStore Run-event JSONL
                                  │ body / reasoning / tool events + evidence
                                  │ contextRef / stateRef / payloadRef
                                  └───────── CAS: State / Context / Step / body
                                  │
                                  ├── conversation projection
existing tool-output stream + MCP audit ──┤
                                  │
API authentication and Session scoping ── trajectory/server
                                  │ index / detail / export
Session entry ── authenticated TrajectoryPort ── trajectory/web
```

`packages/trajectory` owns the contract, read-only projections, and viewer.
`services/api/src/trajectory.ts` injects Session Agent scope and events. The HTTP host
authenticates, and the Web host supplies only the entry and authenticated requests.
Components do not depend back on services/apps and do not change AgentLoop or tool policy.

Model input is `ModelContextSnapshot.input` at the `ProviderModelClient.invoke` boundary,
not a newly assembled context or a provider-wire representation. The matching
`ContextAssemblyRecord.state` points to the frozen state version. New events record
`contextRef` and `recordedAt`, distinguishing retries of one turn. Partially returned
reasoning is shown only as recorded.

### Events and versions have separate roles

New execution writes only the existing SessionStore Run-event stream, not a separate
`trajectories/<agent-key>/<run-key>.jsonl`. Its outer `{createdAt, sequence, event}`
format stays unchanged. `event.evidence` adds `agentId`, `agentRunId`,
`requestExecutionId`, `turn`, `recordedAt`, and optional `responseId`, `contextRef`, and
`stateRef`. Consecutive increments retain the first capture time and `endedAt`; they are
never merged across responses, Agent Runs, or contexts. Existing body, reasoning, and
tool events remain the source of truth.

Information with no conversation equivalent is added as `agent.record` in the same stream:
`context.captured` publishes invocation input, `model.completed` references the complete
model response and usage, `state.committed` associates state after a successful Step, and
`context_recovery` records input-overflow recovery. CAS content is persisted before the
entry is written. Main Agents use the main stream, Subagents their existing Subagent
stream, and command output its existing tool-output stream. Streams merge by head capture
time, not CAS hash, file mtime, or whole-run end time. Strict cross-machine causal order is
not promised.

Old independent journals and `EventSegment` remain read-only compatible. They are not
migrated, rewritten, or removed. When an old segment and a Run increment have the same
Agent, response ID, channel, and complete text, the display prefers the Run event because
it retains the exact context relationship. Similar text from different responses is not a
duplicate. Unreliable timestamps are labelled **Time not recorded** and receive no
timeline position. Backups must retain Run streams, old compatibility logs, CAS, and the
reference store.

The trajectory reader never writes data. One complete model response is stored as one
`ModelAction`: `model.completed.payloadRef` and the successful Step action refer to the
same object. Existing `AgentEventPayload` remains readable. Context and Agent state reuse
the versioned snapshot system; MCP audit, command output, and conversation increments keep
their existing consumers. The viewer turns only `model.completed`, including normalized
legacy `ModelAction`, into a model-output node and never merges requests by textual
similarity or adjacent timestamps.

System-prompt provenance is checked against `admitted.sections`, `rendered.sectionIds`,
and the actual `systemPrompt`. When the check fails or a legacy fallback is used, the
viewer shows the actual prompt and labels the source unavailable. Candidate contributions
and compaction remain assembly evidence in the API/export rather than masquerading as
final input.

## API and export

Some old Subagent events retain only parameter summaries. With matching execution owner,
unique call ID, and tool name, a read projection can supplement complete parameters from
an old `EventSegment`. If both contain parameters that disagree, it does not merge them.
Supplementation changes no source JSONL or CAS data.

| Endpoint | Returns |
| --- | --- |
| `GET /api/sessions/:id/trajectory` | Agent list, event entries, untimed records, real-time and integrity notices; `historicalEntries` remains a compatibility alias |
| `GET /api/sessions/:id/trajectory/detail?id=…` | A Session node with its context, state, and assembly evidence |
| `GET /api/sessions/:id/trajectory/export` | NDJSON download |

The export starts with `type: trajectory`, including timed and untimed-record indexes,
then self-contained `type: entry` details, and ends with `type: complete` and the record
count. UI filters do not remove underlying records or affect export. A stream or read
failure without a completion record is not a complete export. Export is observation
evidence, not an executable recovery package: workspace binaries, external MCP services,
and environment processes are not packaged.

The API does not permit arbitrary CAS-address reads. It first resolves the current
Session's main/Subagents and published references. Missing Session/node returns 404 and
unauthenticated access returns 401. Structured credential fields are redacted, but free
text can still be sensitive.

## Compatibility and limits

- New time and association fields are backward compatible. Historical records without a
  time or context relationship are listed with an explicit notice, never fabricated.
- Successful Steps still commit atomically. Failed/cancelled input remains under audit
  roots. Forced process termination and persistence failures can lose data that was not
  written to disk.
- Run JSONL retains SessionStore read semantics. The legacy journal reader's diagnostics
  for incomplete tails, sequence gaps, and damaged records do not imply identical
  diagnostics for the Run stream. There is no claim of cross-store transaction or
  power-loss durability.
- Details are read on demand. Existing Run events can merge consecutive model increments
  before writing; details retain persisted merged content and do not promise provider-token
  boundaries. Pagination or virtual lists for very large histories may evolve later.
- This is an observation component, not a model tool or a plugin enable/disable setting.
  Viewing or exporting does not execute models, tools, recovery, publishing, or evolution.

See [plugin mechanism](plugins.md), [Agent backend](agent-backend.md), and
[content-addressable storage](cas.md).
