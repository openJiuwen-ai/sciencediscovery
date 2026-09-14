// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

import React, { useEffect, useMemo, useRef, useState } from "react";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { SkillReviewDraft, SkillReviewFile } from "@sciencediscovery/schema";

import { useLocale, type MessageKey } from "./i18n/index.js";

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
  const { t } = useLocale();
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
      <div className="skill-pr-toolbar-title"><span aria-hidden="true">⇄</span><strong>{t("skillReview.diffTitle")}</strong><small>{t(changeSummary.changed === 1 ? "skillReview.changedLineOne" : "skillReview.changedLines", { count: changeSummary.changed })}</small></div>
      <div className="skill-pr-summary" aria-label={t("skillReview.changeSummaryAria", { additions: changeSummary.additions, deletions: changeSummary.deletions })}>
        <span className="removed">−{changeSummary.deletions}</span>
        <span className="added">+{changeSummary.additions}</span>
        <button onClick={() => setSplitPercentage(50)} title={t("skillReview.resetSplitTitle")} type="button">50 / 50</button>
      </div>
    </div>
    <div className="skill-pr-scroll">
      <div className="skill-pr-frame" ref={frameRef} style={frameStyle}>
        <div className="skill-pr-headings">
          <div><span className="skill-pr-version-badge">A</span><span className="skill-pr-heading-copy"><strong title={leftLabel}>{leftLabel}</strong><small>{t("skillReview.baseHeading", { count: changeSummary.deletions })}</small></span></div>
          <div><span className="skill-pr-version-badge">B</span><span className="skill-pr-heading-copy"><strong title={rightLabel}>{rightLabel}</strong><small>{t("skillReview.compareHeading", { count: changeSummary.additions })}</small></span><span className={`skill-pr-file-status ${status}`}>{skillFileDiffStatusLabel(status, t)}</span></div>
        </div>
        <div aria-label={t("skillReview.rowsAria", { left: leftLabel, right: rightLabel })} className="skill-pr-rows" role="table">
          {rows.map((row, rowIndex) => {
            const changedPair = row.kind === "modified" && row.left && row.right;
            return <div className={`skill-pr-row ${row.kind}`} key={`${row.left?.lineNumber ?? ""}-${row.right?.lineNumber ?? ""}-${rowIndex}`} role="row">
              <DiffCell line={row.left} marker={row.kind === "unchanged" ? "" : "-"} other={changedPair ? row.right!.text : undefined} tone={row.kind === "modified" || row.kind === "removed" ? "removed" : row.left ? "unchanged" : "empty"} />
              <DiffCell line={row.right} marker={row.kind === "unchanged" ? "" : "+"} other={changedPair ? row.left!.text : undefined} tone={row.kind === "modified" || row.kind === "added" ? "added" : row.right ? "unchanged" : "empty"} />
            </div>;
          })}
        </div>
        <button
          aria-label={t("skillReview.resizeAria")}
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
          title={t("skillReview.resizeTitle")}
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

const FILE_STATUS_KEYS: Record<SkillFileDiffStatus, MessageKey> = {
  added: "skillReview.fileStatus.added",
  modified: "skillReview.fileStatus.modified",
  removed: "skillReview.fileStatus.removed",
  unchanged: "skillReview.fileStatus.unchanged",
};

export type SkillFileTranslate = (key: MessageKey, variables?: Record<string, string | number>) => string;

export function skillFileDiffStatusLabel(status: SkillFileDiffStatus, t: SkillFileTranslate): string {
  const key = FILE_STATUS_KEYS[status];
  if (!key) return status;
  const label = t(key);
  // Before the catalogue knows the key, t() echoes the key itself — fall back
  // to the raw status so unknown or untranslated values stay readable.
  return label === key ? status : label;
}

function proposalSourceLabel(t: SkillFileTranslate, draft: SkillReviewDraft): string {
  switch (draft.provenance?.source) {
    case "git": return t("skillReview.source.gitPackage");
    case "local-import": return t("skillReview.source.importedPackage");
    case "manual": return t("skillReview.source.manualProposal");
    case "session-distill": return t("skillReview.source.sessionDistill");
    default: return t("skillReview.source.agentProposal");
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
  const { t } = useLocale();
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
  const proposalLabel = proposalSourceLabel(t, draft);
  const pendingLabel = !draft.provenance || draft.provenance.source === "agent" ? t("skillReview.pendingAgentDraft") : t("skillReview.pendingSource", { source: proposalLabel });
  const previousProposalLabel = !draft.provenance || draft.provenance.source === "agent" ? t("skillReview.previousAgentProposal") : t("skillReview.previousProposal");

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
    <section aria-label={t("skillReview.dialogAria", { name: draft.name })} aria-modal="true" className="skill-review-dialog" role="dialog">
      <header className="skill-review-header">
        <div><div className="skill-review-heading-row"><span className="eyebrow">{pendingLabel}</span><span className="skill-review-status">{draft.comparisonSource === "previous-agent-draft" ? t("skillReview.revisedProposal") : draft.baseRevision === undefined ? t("skillReview.newSkill") : t("skillReview.updateFrom", { revision: draft.baseRevision })}</span></div><h2>{draft.name}</h2><p>{t("skillReview.reviewIntro")}{draft.provenance?.git ? ` ${t("skillReview.sourceCommit", { commit: draft.provenance.git.commit.slice(0, 12) })}` : ""}</p></div>
        <button aria-label={t("skillReview.closeAria")} className="icon-button" disabled={busy} onClick={onClose} type="button">×</button>
      </header>
      <div className="skill-review-tabs" role="tablist">
        <button aria-selected={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} role="tab" type="button"><strong>{t("skillReview.editFilesTab")}</strong><small>{t(files.length === 1 ? "skillReview.filesCountOne" : "skillReview.filesCount", { count: files.length })}</small></button>
        <button aria-selected={mode === "diff"} className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")} role="tab" type="button"><strong>{t("skillReview.reviewChangesTab")}</strong><small>{t(changedFileCount === 1 ? "skillReview.changesCountOne" : "skillReview.changesCount", { count: changedFileCount })}</small></button>
      </div>
      <div className="skill-review-workspace">
        <aside aria-label={t("skillReview.draftFilesAria")} className="skill-review-files">
          <div className="skill-review-files-heading"><strong>{t("skillReview.packageFiles")}</strong><span>{paths.length}</span></div>
          {paths.map((path) => {
            const status = skillFileDiffStatus(baseByPath.get(path), proposedByPath.get(path));
            return <button className={path === activePath ? "active" : ""} key={path} onClick={() => setActivePath(path)} type="button"><span>{path}</span><small className={status}>{skillFileDiffStatusLabel(status, t)}</small></button>;
          })}
          {mode === "edit" ? <div className="skill-review-add"><input aria-label={t("skillReview.newFilePathAria")} onChange={(event) => setNewPath(event.target.value)} placeholder="references/guide.md" value={newPath} /><button disabled={!newPath.trim() || proposedByPath.has(newPath.trim())} onClick={addFile} type="button">{t("skillReview.addFile")}</button></div> : null}
        </aside>
        <main className="skill-review-content">
          {mode === "edit" ? activeFile ? <>
            <div className="skill-review-path"><input aria-label={t("skillReview.filePathAria")} disabled={activePath === "SKILL.md" || busy} onChange={(event) => renameActive(event.target.value)} value={activePath} />{activePath !== "SKILL.md" ? <button className="danger-button" disabled={busy} onClick={removeActive} type="button">{t("skillReview.removeFile")}</button> : null}</div>
            {activeFile.binary ? <div className="skill-binary-editor-note"><strong>{t("skillReview.binaryPreserved")}</strong><p>{t("skillReview.binaryPreservedHint")}</p></div> : <textarea aria-label={t("skillReview.editFileAria", { path: activePath })} disabled={busy} onChange={(event) => updateActive(event.target.value)} spellCheck={false} value={activeFile.content} />}
          </> : <p>{t("skillReview.selectOrAddFile")}</p> : activeBase?.binary || activeFile?.binary ? <div className="skill-binary-diff"><section><h3>{draft.comparisonSource === "previous-agent-draft" ? previousProposalLabel : t("skillReview.installedRevision", { revision: draft.baseRevision ?? "" })}</h3><p>{activeBase ? t("skillReview.binaryFileBytes", { size: activeBase.size }) : t("skillReview.fileDidNotExist")}</p></section><section><h3>{proposalLabel}</h3><p>{activeFile ? activeFile.binary ? t("skillReview.binaryExactBytes") : t("skillReview.utf8Characters", { count: activeFile.content.length }) : t("skillReview.fileRemoved")}</p></section></div> : <SkillLineDiff
            after={activeFile?.content}
            before={activeBase?.content}
            leftLabel={hasComparison ? draft.comparisonSource === "previous-agent-draft" ? previousProposalLabel : t("skillReview.installedRevision", { revision: draft.baseRevision ?? "" }) : t("skillReview.previousNone")}
            rightLabel={proposalLabel}
            status={activeStatus}
          />}
        </main>
      </div>
      <div className="skill-review-error-slot">{error ? <p className="skill-manager-error" role="alert">{error}</p> : null}</div>
      <footer className="skill-review-footer"><button className="skill-discard-button" disabled={busy} onClick={onDiscard} type="button">{t("skillReview.discardDraft")}</button><div><button className="secondary-button" disabled={busy} onClick={onClose} type="button">{t("skillReview.reviewLater")}</button><button className="primary-button" disabled={busy || !files.some((file) => file.path === "SKILL.md")} onClick={() => onConfirm(files)} type="button">{busy ? t("skillReview.publishing") : t("skillReview.publishSkill")}</button></div></footer>
    </section>
  </div>;
}
