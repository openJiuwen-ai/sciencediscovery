// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { ReactNode } from "react";

import type { Subagent, SubagentStep } from "../api/types.js";
import { Markdown } from "../Markdown.js";
import { finalSteps } from "../run-stream/subagent.js";
import { TEXT } from "../text.js";

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function stepStatusIcon(step: SubagentStep): string {
  if (step.status === "running") return "◌";
  if (step.status === "failed") return "!";
  return "✓";
}

function StepBody({ step }: { step: SubagentStep }) {
  const input = step.args !== undefined
    ? pretty(step.args)
    : step.input !== undefined && step.input !== ""
      ? step.input
      : undefined;
  const output = step.content.trim();
  const progress = step.progress?.trim() ?? "";
  const details = step.details === undefined ? undefined : pretty(step.details);
  return (
    <>
      {input === undefined ? null : (
        <>
          <div className="subagent-step-label">{TEXT.conversation.toolInput}</div>
          <pre className="tab-content-source subagent-pre">{input}</pre>
        </>
      )}
      {output === "" && progress === "" && details === undefined ? null : (
        <>
          <div className="subagent-step-label">{TEXT.subagent.output}</div>
          <div className="subagent-tool-output">
            {output === "" ? null : (
              <div className="text">
                <Markdown>{output}</Markdown>
              </div>
            )}
            {progress === "" ? null : (
              <pre className="tab-content-source subagent-pre">{progress}</pre>
            )}
            {details === undefined ? null : (
              <pre className="tab-content-source subagent-pre">{details}</pre>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** One step of the child's own run.
 *
 * Everything but the final answer is folded, because the panel's job is to let
 * someone check what the child did without turning into a second transcript.
 * A running step is left open: it is the one the reader came to watch. */
function StepRow({ step }: { step: SubagentStep }) {
  if (step.kind === "tool") {
    const name = step.toolName ?? TEXT.subagent.tool;
    return (
      <details className={`subagent-step is-tool is-${step.status ?? "completed"}`}>
        <summary>
          <span aria-hidden="true" className="subagent-step-icon">{stepStatusIcon(step)}</span>
          <span className="subagent-step-title">{TEXT.subagent.tool} · {name}</span>
          <span aria-hidden="true" className="collapse-chev">›</span>
        </summary>
        <div className="subagent-step-body">
          <StepBody step={step} />
        </div>
      </details>
    );
  }

  const text = step.content.trim();
  if (step.kind === "assistant") {
    // A reply is the child's own prose, not an event in its run. It is always
    // open: folding the thing the reader came to read saves nothing.
    return (
      <div className="subagent-step is-assistant">
        <div className="subagent-step-body">
          {text === "" ? (
            <div className="workspace-empty">{TEXT.conversation.emptyTurn}</div>
          ) : (
            <div className="text">
              <Markdown>{text}</Markdown>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step.kind !== "thinking") return null;
  return (
    <details className={`subagent-step is-${step.kind}`} open={step.status === "running"}>
      <summary>
        <span aria-hidden="true" className="subagent-step-icon">✳</span>
        <span className="subagent-step-title">{TEXT.subagent.thinking}</span>
        <span aria-hidden="true" className="collapse-chev">›</span>
      </summary>
      <div className="subagent-step-body">
        {text === "" ? (
          <div className="workspace-empty">{TEXT.conversation.emptyTurn}</div>
        ) : (
          <div className="text">
            <Markdown>{text}</Markdown>
          </div>
        )}
      </div>
    </details>
  );
}

/** A named part of the child's record that starts closed.
 *
 * The brief and the timeline answer questions the answer itself raises, so they
 * sit behind a summary: the panel opens on what the child concluded, and the
 * reader opens a card when they want to check how it got there. A card that
 * starts open would push the answer below the fold on every visit. */
function FoldCard({ children, className, title }: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <details className={`subagent-card${className === undefined ? "" : ` ${className}`}`}>
      <summary>
        <span className="subagent-section-title">{title}</span>
        <span aria-hidden="true" className="collapse-chev">›</span>
      </summary>
      <div className="subagent-card-body">{children}</div>
    </details>
  );
}

/**
 * One subagent's execution and output, as the right panel shows it.
 *
 * This is the child's own record and nothing else: no roster, no "currently
 * active" list, no sibling to switch to. The transcript already says which
 * task was delegated; this says what the child did with it.
 */
export function SubagentDetail({
  loading = false,
  subagent,
}: {
  /** The catalog read that fills a replayed child's steps is still in flight. */
  loading?: boolean;
  subagent: Subagent;
}) {
  // System steps are the runtime's own bookkeeping — turn markers, brief
  // revisions — not work the child did, and in a long run they are the
  // loudest part of the timeline. The panel leaves them out.
  const recorded = subagent.steps.filter((step) => step.kind !== "system");
  // 输出 is the child's deliverable, and only a completed child has one. What a
  // running or timed-out child last said is a progress note, not its answer —
  // labelling that as output would claim it delivered something it never
  // finished. Those replies stay where they were said: in the timeline.
  //
  // The answer can be several steps — a message is ended and started again
  // whenever the runtime records something mid-stream — so it is the trailing
  // run of assistant steps joined, not the last one alone. See `finalSteps`.
  const final = subagent.status === "completed" ? finalSteps(recorded) : [];
  const answer = final.map((step) => step.content).join("").trim();
  const inAnswer = new Set(final);
  const steps = recorded.filter((step) => !inAnswer.has(step));
  const failed = subagent.status === "failed"
    || subagent.status === "timed_out"
    || subagent.status === "cancelled";
  // The brief the child was handed. Without it the timeline answers "what did
  // it do" while leaving "what was it asked" unanswerable.
  const prompt = subagent.input.prompt.trim();
  const inputPaths = subagent.input.inputPaths ?? [];

  return (
    <div className="subagent-detail">
      <div className={`subagent-status is-${subagent.status}`}>
        <span aria-hidden="true" className="subagent-status-icon">
          {subagent.status === "running" ? <span className="spinner" /> : failed ? "!" : "✓"}
        </span>
        <span>{TEXT.subagent.status[subagent.status]}</span>
        {subagent.turnCount > 0 ? (
          <span className="subagent-status-meta">{TEXT.subagent.turns(subagent.turnCount)}</span>
        ) : null}
        {subagent.usage === undefined ? null : (
          <span className="subagent-status-meta">{TEXT.subagent.tokens(subagent.usage.totalTokens)}</span>
        )}
      </div>
      {failed && subagent.error !== undefined ? (
        <div className="subagent-error">
          <div className="subagent-error-title">
            {subagent.status === "timed_out"
              ? TEXT.subagent.timedOutTitle
              : subagent.status === "cancelled"
                ? TEXT.subagent.cancelledTitle
                : TEXT.subagent.failedTitle}
          </div>
          <div>{subagent.error}</div>
        </div>
      ) : null}

      {prompt === "" && inputPaths.length === 0 ? null : (
        <FoldCard className="subagent-task" title={TEXT.subagent.task}>
          {prompt === "" ? null : (
            <div className="text">
              <Markdown>{prompt}</Markdown>
            </div>
          )}
          {inputPaths.length === 0 ? null : (
            <div className="subagent-task-paths">
              <span className="subagent-task-paths-label">{TEXT.subagent.inputFiles}</span>
              {inputPaths.map((path) => (
                <span className="subagent-task-path" key={path} title={path}>{path}</span>
              ))}
            </div>
          )}
        </FoldCard>
      )}

      <FoldCard className="subagent-execution" title={TEXT.subagent.detail}>
        {steps.length === 0 && answer === "" ? (
          loading ? (
            <div className="workspace-empty subagent-loading">
              <span className="spinner" />
              <span>{TEXT.subagent.loading}</span>
            </div>
          ) : (
            <div className="workspace-empty">{TEXT.subagent.emptySteps}</div>
          )
        ) : (
          <div className="subagent-steps">
            {steps.map((step) => <StepRow key={step.id} step={step} />)}
          </div>
        )}
      </FoldCard>

      {answer === "" ? null : (
        <section className="subagent-output">
          <div className="subagent-section-title">{TEXT.subagent.output}</div>
          <div className="text">
            <Markdown>{answer}</Markdown>
          </div>
        </section>
      )}
    </div>
  );
}
