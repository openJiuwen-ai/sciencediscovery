// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

import { useEffect, useMemo, useRef, useState } from "react";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { SkillReviewDraft, SkillReviewFile } from "@sciencediscovery/schema";

export interface EditableSkillFile {
  binary?: boolean;
  content: string;
  encodedContent?: string;
  path: string;
}

export type SkillFileDiffStatus = "added" | "modified" | "removed" | "unchanged";

export interface SkillLineDiffRow {
  kind: SkillFileDiffStatus;
  left?: { lineNumber: number; text: string };
  right?: { lineNumber: number; text: string };
}

type LineOperation = {
  lineNumber: number;
  text: string;
  type: "added" | "removed" | "unchanged";
};

function draftHasComparison(draft: SkillReviewDraft): boolean {
  return draft.comparisonSource !== undefined || draft.baseRevision !== undefined;
}

function compareSkillPaths(left: string, right: string): number {
  if (left === "SKILL.md") return right === "SKILL.md" ? 0 : -1;
  if (right === "SKILL.md") return 1;
  return left.localeCompare(right);
}

function contentLines(content: string | undefined): string[] {
  return content === undefined ? [] : content.split("\n");
}

function lineOperations(before: string | undefined, after: string | undefined): LineOperation[] {
  const left = contentLines(before);
  const right = contentLines(after);
  const operations: LineOperation[] = [];
  const product = left.length * right.length;

  if (product <= 2_000_000) {
    const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
      for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
        lengths[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
          ? lengths[leftIndex + 1]![rightIndex + 1]! + 1
          : Math.max(lengths[leftIndex + 1]![rightIndex]!, lengths[leftIndex]![rightIndex + 1]!);
      }
    }
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] === right[rightIndex]) {
        operations.push({ lineNumber: leftIndex + 1, text: left[leftIndex]!, type: "unchanged" });
        leftIndex += 1;
        rightIndex += 1;
      } else if (lengths[leftIndex + 1]![rightIndex]! >= lengths[leftIndex]![rightIndex + 1]!) {
        operations.push({ lineNumber: leftIndex + 1, text: left[leftIndex]!, type: "removed" });
        leftIndex += 1;
      } else {
        operations.push({ lineNumber: rightIndex + 1, text: right[rightIndex]!, type: "added" });
        rightIndex += 1;
      }
    }
    while (leftIndex < left.length) {
      operations.push({ lineNumber: leftIndex + 1, text: left[leftIndex]!, type: "removed" });
      leftIndex += 1;
    }
    while (rightIndex < right.length) {
      operations.push({ lineNumber: rightIndex + 1, text: right[rightIndex]!, type: "added" });
      rightIndex += 1;
    }
    return operations;
  }

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix += 1;
  for (let index = 0; index < prefix; index += 1) {
    operations.push({ lineNumber: index + 1, text: left[index]!, type: "unchanged" });
  }
  for (let index = prefix; index < left.length - suffix; index += 1) {
    operations.push({ lineNumber: index + 1, text: left[index]!, type: "removed" });
  }
  for (let index = prefix; index < right.length - suffix; index += 1) {
    operations.push({ lineNumber: index + 1, text: right[index]!, type: "added" });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const leftIndex = left.length - offset;
    operations.push({ lineNumber: leftIndex + 1, text: left[leftIndex]!, type: "unchanged" });
  }
  return operations;
}

export function buildSkillLineDiff(before: string | undefined, after: string | undefined): SkillLineDiffRow[] {
  const operations = lineOperations(before, after);
  const rows: SkillLineDiffRow[] = [];
  let index = 0;
  let rightLineNumber = 0;
  while (index < operations.length) {
    const operation = operations[index]!;
    if (operation.type === "unchanged") {
      rightLineNumber += 1;
      rows.push({
        kind: "unchanged",
        left: { lineNumber: operation.lineNumber, text: operation.text },
        right: { lineNumber: rightLineNumber, text: operation.text },
      });
      index += 1;
      continue;
    }
    const removed: LineOperation[] = [];
    const added: LineOperation[] = [];
    while (index < operations.length && operations[index]!.type !== "unchanged") {
      const changed = operations[index]!;
      if (changed.type === "removed") removed.push(changed);
      else added.push(changed);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      const leftLine = removed[offset];
      const rightLine = added[offset];
      if (rightLine) rightLineNumber = rightLine.lineNumber;
      rows.push({
        kind: leftLine && rightLine ? "modified" : leftLine ? "removed" : "added",
        ...(leftLine ? { left: { lineNumber: leftLine.lineNumber, text: leftLine.text } } : {}),
        ...(rightLine ? { right: { lineNumber: rightLine.lineNumber, text: rightLine.text } } : {}),
      });
    }
  }
  return rows;
}

function InlineChangedText({ other, text }: { other: string; text: string }) {
  let prefix = 0;
  while (prefix < text.length && prefix < other.length && text[prefix] === other[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < text.length - prefix && suffix < other.length - prefix
    && text[text.length - suffix - 1] === other[other.length - suffix - 1]) suffix += 1;
  const changedEnd = text.length - suffix;
  return <>{text.slice(0, prefix)}{changedEnd > prefix ? <mark>{text.slice(prefix, changedEnd)}</mark> : null}{text.slice(changedEnd)}</>;
}

function DiffCell({ line, marker, other, tone }: {
  line?: { lineNumber: number; text: string };
  marker: "+" | "-" | "";
  other?: string;
  tone: "added" | "empty" | "removed" | "unchanged";
}) {
  return <div className={`skill-pr-cell ${tone}`}>
    <span className="skill-pr-line-number">{line?.lineNumber ?? ""}</span>
    <span aria-hidden="true" className="skill-pr-marker">{line ? marker : ""}</span>
    <code>{line ? other !== undefined ? <InlineChangedText other={other} text={line.text} /> : line.text || " " : " "}</code>
  </div>;
}

const MIN_DIFF_SPLIT = 24;
const MAX_DIFF_SPLIT = 76;

export function skillDiffSplitFromClientX(clientX: number, frameLeft: number, frameWidth: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(frameLeft) || !Number.isFinite(frameWidth) || frameWidth <= 0) return 50;
  const percentage = ((clientX - frameLeft) / frameWidth) * 100;
  return Math.round(Math.min(MAX_DIFF_SPLIT, Math.max(MIN_DIFF_SPLIT, percentage)) * 10) / 10;
}

export function SkillLineDiff({ after, before, leftLabel, rightLabel, status }: {
  after: string | undefined;
  before: string | undefined;
  leftLabel: string;
  rightLabel: string;
  status: SkillFileDiffStatus;
}) {
  const rows = useMemo(() => buildSkillLineDiff(before, after), [after, before]);
  const frameRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const [splitPercentage, setSplitPercentage] = useState(50);
  const changeSummary = useMemo(() => rows.reduce((summary, row) => ({
    additions: summary.additions + (row.kind === "added" || row.kind === "modified" ? 1 : 0),
    changed: summary.changed + (row.kind === "unchanged" ? 0 : 1),
    deletions: summary.deletions + (row.kind === "removed" || row.kind === "modified" ? 1 : 0),
  }), { additions: 0, changed: 0, deletions: 0 }), [rows]);

  const resizeFromClientX = (clientX: number) => {
    const frame = frameRef.current;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    setSplitPercentage(skillDiffSplitFromClientX(clientX, bounds.left, bounds.width));
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    resizeFromClientX(event.clientX);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    resizeFromClientX(event.clientX);
  };
  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  };
  const handleSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let next = splitPercentage;
    if (event.key === "ArrowLeft") next -= 2;
    else if (event.key === "ArrowRight") next += 2;
    else if (event.key === "Home") next = MIN_DIFF_SPLIT;
    else if (event.key === "End") next = MAX_DIFF_SPLIT;
    else return;
    event.preventDefault();
    setSplitPercentage(Math.min(MAX_DIFF_SPLIT, Math.max(MIN_DIFF_SPLIT, next)));
  };
  const frameStyle = { "--skill-diff-left": `${splitPercentage}%` } as CSSProperties;

  return <div className={`skill-pr-diff${resizing ? " resizing" : ""}`}>
    <div className="skill-pr-toolbar">
      <div className="skill-pr-toolbar-title"><span aria-hidden="true">⇄</span><strong>Side-by-side diff</strong><small>{changeSummary.changed} changed {changeSummary.changed === 1 ? "line" : "lines"}</small></div>
      <div className="skill-pr-summary" aria-label={`${changeSummary.additions} additions and ${changeSummary.deletions} deletions`}>
        <span className="removed">−{changeSummary.deletions}</span>
        <span className="added">+{changeSummary.additions}</span>
        <button onClick={() => setSplitPercentage(50)} title="Reset the A and B columns to equal width" type="button">50 / 50</button>
      </div>
    </div>
    <div className="skill-pr-scroll">
      <div className="skill-pr-frame" ref={frameRef} style={frameStyle}>
        <div className="skill-pr-headings">
          <div><span className="skill-pr-version-badge">A</span><span className="skill-pr-heading-copy"><strong title={leftLabel}>{leftLabel}</strong><small>Base · −{changeSummary.deletions}</small></span></div>
          <div><span className="skill-pr-version-badge">B</span><span className="skill-pr-heading-copy"><strong title={rightLabel}>{rightLabel}</strong><small>Compare · +{changeSummary.additions}</small></span><span className={`skill-pr-file-status ${status}`}>{status}</span></div>
        </div>
        <div aria-label={`${leftLabel} compared with ${rightLabel}`} className="skill-pr-rows" role="table">
          {rows.map((row, rowIndex) => {
            const changedPair = row.kind === "modified" && row.left && row.right;
            return <div className={`skill-pr-row ${row.kind}`} key={`${row.left?.lineNumber ?? ""}-${row.right?.lineNumber ?? ""}-${rowIndex}`} role="row">
              <DiffCell line={row.left} marker={row.kind === "unchanged" ? "" : "-"} other={changedPair ? row.right!.text : undefined} tone={row.kind === "modified" || row.kind === "removed" ? "removed" : row.left ? "unchanged" : "empty"} />
              <DiffCell line={row.right} marker={row.kind === "unchanged" ? "" : "+"} other={changedPair ? row.left!.text : undefined} tone={row.kind === "modified" || row.kind === "added" ? "added" : row.right ? "unchanged" : "empty"} />
            </div>;
          })}
        </div>
        <button
          aria-label="Resize version A and version B columns"
          aria-orientation="vertical"
          aria-valuemax={MAX_DIFF_SPLIT}
          aria-valuemin={MIN_DIFF_SPLIT}
          aria-valuenow={Math.round(splitPercentage)}
          className="skill-pr-resizer"
          onDoubleClick={() => setSplitPercentage(50)}
          onKeyDown={handleSeparatorKeyDown}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          role="separator"
          title="Drag to resize A and B. Double-click to reset."
          type="button"
        ><span aria-hidden="true">⋮</span></button>
      </div>
    </div>
  </div>;
}

export function skillFileDiffStatus(base: SkillReviewFile | undefined, proposed: EditableSkillFile | undefined): SkillFileDiffStatus {
  if (!base) return "added";
  if (!proposed) return "removed";
  if (base.binary || proposed.binary) return "modified";
  return base.content === proposed.content ? "unchanged" : "modified";
}

function proposalSourceLabel(draft: SkillReviewDraft): string {
  switch (draft.provenance?.source) {
    case "git": return "Git package";
    case "local-import": return "Imported package";
    case "manual": return "Manual proposal";
    case "session-distill": return "Session distillation";
    default: return "Agent proposal";
  }
}

export function SkillReviewDialog({
  busy,
  draft,
  error,
  onClose,
  onConfirm,
  onDiscard,
}: {
  busy: boolean;
  draft: SkillReviewDraft;
  error?: string;
  onClose: () => void;
  onConfirm: (files: EditableSkillFile[]) => void;
  onDiscard: () => void;
}) {
  const [files, setFiles] = useState<EditableSkillFile[]>(() => draft.files.map((file) => ({
    ...(file.binary ? { binary: true, encodedContent: file.encodedContent } : {}),
    content: file.content ?? "",
    path: file.path,
  })));
  const [activePath, setActivePath] = useState("SKILL.md");
  const [mode, setMode] = useState<"diff" | "edit">(() => draftHasComparison(draft) ? "diff" : "edit");
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    const next = draft.files.map((file) => ({
      ...(file.binary ? { binary: true, encodedContent: file.encodedContent } : {}),
      content: file.content ?? "",
      path: file.path,
    }));
    setFiles(next);
    setActivePath(next.some((file) => file.path === "SKILL.md") ? "SKILL.md" : next[0]?.path ?? "");
    setMode(draftHasComparison(draft) ? "diff" : "edit");
  }, [draft]);

  const baseByPath = useMemo(() => new Map(draft.baseFiles.map((file) => [file.path, file])), [draft.baseFiles]);
  const proposedByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const paths = useMemo(() => [...new Set([...baseByPath.keys(), ...proposedByPath.keys()])].toSorted(compareSkillPaths), [baseByPath, proposedByPath]);
  const activeFile = proposedByPath.get(activePath);
  const activeBase = baseByPath.get(activePath);
  const hasComparison = draftHasComparison(draft);
  const activeStatus = skillFileDiffStatus(activeBase, activeFile);
  const changedFileCount = paths.filter((path) => skillFileDiffStatus(baseByPath.get(path), proposedByPath.get(path)) !== "unchanged").length;
  const proposalLabel = proposalSourceLabel(draft);
  const pendingLabel = !draft.provenance || draft.provenance.source === "agent" ? "Pending Agent draft" : `Pending ${proposalLabel}`;
  const previousProposalLabel = !draft.provenance || draft.provenance.source === "agent" ? "Previous Agent proposal" : "Previous proposal";

  function updateActive(content: string): void {
    setFiles((current) => current.map((file) => file.path === activePath ? { ...file, content } : file));
  }

  function renameActive(path: string): void {
    if (!activeFile || activePath === "SKILL.md") return;
    setFiles((current) => current.map((file) => file.path === activePath ? { ...file, path } : file));
    setActivePath(path);
  }

  function addFile(): void {
    const path = newPath.trim();
    if (!path || proposedByPath.has(path)) return;
    setFiles((current) => [...current, { content: "", path }].toSorted((left, right) => left.path.localeCompare(right.path)));
    setActivePath(path);
    setNewPath("");
  }

  function removeActive(): void {
    if (!activeFile || activePath === "SKILL.md") return;
    const next = files.filter((file) => file.path !== activePath);
    setFiles(next);
    setActivePath(next[0]?.path ?? "");
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section aria-label={`Review Agent Skill draft ${draft.name}`} aria-modal="true" className="skill-review-dialog" role="dialog">
      <header className="skill-review-header">
        <div><div className="skill-review-heading-row"><span className="eyebrow">{pendingLabel}</span><span className="skill-review-status">{draft.comparisonSource === "previous-agent-draft" ? "Revised proposal" : draft.baseRevision === undefined ? "New Skill" : `Update from r${draft.baseRevision}`}</span></div><h2>{draft.name}</h2><p>Review the package before it becomes available to Agents.{draft.provenance?.git ? ` Source commit ${draft.provenance.git.commit.slice(0, 12)}.` : ""}</p></div>
        <button aria-label="Close Skill draft review" className="icon-button" disabled={busy} onClick={onClose} type="button">×</button>
      </header>
      <div className="skill-review-tabs" role="tablist">
        <button aria-selected={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} role="tab" type="button"><strong>Edit files</strong><small>{files.length} file{files.length === 1 ? "" : "s"}</small></button>
        <button aria-selected={mode === "diff"} className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")} role="tab" type="button"><strong>Review changes</strong><small>{changedFileCount} change{changedFileCount === 1 ? "" : "s"}</small></button>
      </div>
      <div className="skill-review-workspace">
        <aside aria-label="Draft files" className="skill-review-files">
          <div className="skill-review-files-heading"><strong>Package files</strong><span>{paths.length}</span></div>
          {paths.map((path) => {
            const status = skillFileDiffStatus(baseByPath.get(path), proposedByPath.get(path));
            return <button className={path === activePath ? "active" : ""} key={path} onClick={() => setActivePath(path)} type="button"><span>{path}</span><small className={status}>{status}</small></button>;
          })}
          {mode === "edit" ? <div className="skill-review-add"><input aria-label="New Skill file path" onChange={(event) => setNewPath(event.target.value)} placeholder="references/guide.md" value={newPath} /><button disabled={!newPath.trim() || proposedByPath.has(newPath.trim())} onClick={addFile} type="button">Add file</button></div> : null}
        </aside>
        <main className="skill-review-content">
          {mode === "edit" ? activeFile ? <>
            <div className="skill-review-path"><input aria-label="Skill file path" disabled={activePath === "SKILL.md" || busy} onChange={(event) => renameActive(event.target.value)} value={activePath} />{activePath !== "SKILL.md" ? <button className="danger-button" disabled={busy} onClick={removeActive} type="button">Remove</button> : null}</div>
            {activeFile.binary ? <div className="skill-binary-editor-note"><strong>Binary file preserved</strong><p>This resource cannot be edited as text. You can rename or remove it, and confirmation will preserve its exact bytes.</p></div> : <textarea aria-label={`Edit ${activePath}`} disabled={busy} onChange={(event) => updateActive(event.target.value)} spellCheck={false} value={activeFile.content} />}
          </> : <p>Select or add a file.</p> : activeBase?.binary || activeFile?.binary ? <div className="skill-binary-diff"><section><h3>{draft.comparisonSource === "previous-agent-draft" ? previousProposalLabel : `Installed · r${draft.baseRevision}`}</h3><p>{activeBase ? `Binary file · ${activeBase.size} bytes` : "File did not exist"}</p></section><section><h3>{proposalLabel}</h3><p>{activeFile ? activeFile.binary ? "Binary file (exact bytes preserved)" : `${activeFile.content.length} UTF-8 characters` : "File removed"}</p></section></div> : <SkillLineDiff
            after={activeFile?.content}
            before={activeBase?.content}
            leftLabel={hasComparison ? draft.comparisonSource === "previous-agent-draft" ? previousProposalLabel : `Installed · r${draft.baseRevision}` : "Previous · none"}
            rightLabel={proposalLabel}
            status={activeStatus}
          />}
        </main>
      </div>
      <div className="skill-review-error-slot">{error ? <p className="skill-manager-error" role="alert">{error}</p> : null}</div>
      <footer className="skill-review-footer"><button className="skill-discard-button" disabled={busy} onClick={onDiscard} type="button">Discard draft</button><div><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Review later</button><button className="primary-button" disabled={busy || !files.some((file) => file.path === "SKILL.md")} onClick={() => onConfirm(files)} type="button">{busy ? "Confirming…" : draft.baseRevision === undefined ? "Confirm and create Skill" : "Confirm new revision"}</button></div></footer>
    </section>
  </div>;
}
