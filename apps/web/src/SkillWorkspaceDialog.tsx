// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");

import React, { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  SkillDeletionImpact,
  SkillDescriptor,
  SkillLibrary,
  SkillReviewDraft,
  SkillReviewDraftSummary,
  SkillReviewFile,
  SkillVersionSnapshot,
  SkillVersionSummary,
} from "@sciencediscovery/schema";
import { BUILT_IN_SKILL_LIBRARY_ID, DEFAULT_WRITABLE_SKILL_LIBRARY_ID } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { CheckIcon, ChevronRightIcon, CloseIcon, FileIcon, PlusIcon, ProjectIcon, TrashIcon } from "./icons.js";
import { SkillLineDiff, skillFileDiffStatus, type EditableSkillFile } from "./SkillReviewDialog.js";

function comparePaths(left: string, right: string): number {
  if (left === "SKILL.md") return right === "SKILL.md" ? 0 : -1;
  if (right === "SKILL.md") return 1;
  return left.localeCompare(right);
}

export interface SkillFileTreeNode {
  children: SkillFileTreeNode[];
  fileCount: number;
  kind: "directory" | "file";
  name: string;
  path: string;
}

export function buildSkillFileTree(paths: string[]): SkillFileTreeNode[] {
  interface MutableNode {
    children: Map<string, MutableNode>;
    kind: "directory" | "file";
    name: string;
    path: string;
  }
  const root = new Map<string, MutableNode>();
  for (const path of [...new Set(paths)]) {
    const segments = path.split("/").filter(Boolean);
    let siblings = root;
    let currentPath = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const kind = index === segments.length - 1 ? "file" as const : "directory" as const;
      let node = siblings.get(name);
      if (!node) {
        node = { children: new Map(), kind, name, path: currentPath };
        siblings.set(name, node);
      }
      siblings = node.children;
    }
  }
  const finalize = (nodes: Map<string, MutableNode>): SkillFileTreeNode[] => [...nodes.values()].map((node) => {
    const children = finalize(node.children);
    return {
      children,
      fileCount: node.kind === "file" ? 1 : children.reduce((total, child) => total + child.fileCount, 0),
      kind: node.kind,
      name: node.name,
      path: node.path,
    };
  }).toSorted((left, right) => {
    if (left.path === "SKILL.md") return right.path === "SKILL.md" ? 0 : -1;
    if (right.path === "SKILL.md") return 1;
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return finalize(root);
}

function versionTone(version: SkillVersionSummary): string {
  if (version.kind === "agent-proposal") return "proposal";
  if (version.kind === "built-in") return "built-in";
  return "revision";
}

function versionSource(version: SkillVersionSummary): string {
  const provenance = version.provenance;
  switch (provenance?.source) {
    case "agent": return "Agent generated";
    case "built-in": return "Built in";
    case "git": return provenance.git ? `Git · ${provenance.git.commit.slice(0, 12)}` : "Git import";
    case "local-import": return "Local import";
    case "manual": return "Human edit";
    case "session-distill": return "Session distillation";
    default: return version.kind === "agent-proposal" ? "Agent proposal" : "Legacy version";
  }
}

type SkillWorkspaceDeleteTarget =
  | { draftId: string; id: string; kind: "draft" }
  | { id: string; impact: SkillDeletionImpact; kind: "skill" };

export function SkillWorkspaceDialog({
  client,
  drafts,
  initialSkillId,
  onCatalogChange,
  onClose,
  onDraftsChange,
  onError,
  onOpenSession,
  sessionId,
  skills,
}: {
  client: ApiClient;
  drafts: SkillReviewDraftSummary[];
  initialSkillId?: string;
  onCatalogChange: (skills: SkillDescriptor[]) => void;
  onClose: () => void;
  onDraftsChange: (drafts: SkillReviewDraftSummary[]) => void;
  onError: (message: string) => void;
  onOpenSession?: (sessionId: string) => void;
  sessionId?: string;
  skills: SkillDescriptor[];
}) {
  const catalog = useMemo(() => [...new Set([...skills.map((skill) => skill.id), ...drafts.map((draft) => draft.name)])]
    .toSorted(), [drafts, skills]);
  const [query, setQuery] = useState("");
  const [catalogFilter, setCatalogFilter] = useState<"all" | "drafts">("all");
  const [selectedSkillId, setSelectedSkillId] = useState(initialSkillId ?? catalog[0]);
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [versionsSkillId, setVersionsSkillId] = useState<string>();
  const [leftVersionId, setLeftVersionId] = useState<string>();
  const [rightVersionId, setRightVersionId] = useState<string>();
  const [leftSnapshot, setLeftSnapshot] = useState<SkillVersionSnapshot>();
  const [rightSnapshot, setRightSnapshot] = useState<SkillVersionSnapshot>();
  const [reviewDraftDetail, setReviewDraftDetail] = useState<SkillReviewDraft>();
  const [reviewVersionId, setReviewVersionId] = useState<string>();
  const [reviewFiles, setReviewFiles] = useState<EditableSkillFile[]>([]);
  const [reviewFilesVersionId, setReviewFilesVersionId] = useState<string>();
  const [newDraftPath, setNewDraftPath] = useState("");
  const [activePath, setActivePath] = useState("SKILL.md");
  const [mode, setMode] = useState<"compare" | "edit">("edit");
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([]);
  const [mergeTargetId, setMergeTargetId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<SkillWorkspaceDeleteTarget>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [catalogCollapsed, setCatalogCollapsed] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [gitUpdate, setGitUpdate] = useState<{
    candidate: GitSkillImportCandidate;
    inspection: GitSkillRepositoryInspection;
  }>();
  const [skillLibraries, setSkillLibraries] = useState<SkillLibrary[]>([]);
  const [targetLibraryId, setTargetLibraryId] = useState(DEFAULT_WRITABLE_SKILL_LIBRARY_ID);

  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
  const pendingDraft = drafts.find((draft) => draft.name === selectedSkillId);
  const draftNames = useMemo(() => new Set(drafts.map((draft) => draft.name)), [drafts]);
  const visibleCatalog = catalog.filter((id) => (catalogFilter === "all" || draftNames.has(id))
    && id.toLowerCase().includes(query.trim().toLowerCase()));
  const activeVersions = versionsSkillId === selectedSkillId ? versions : [];
  const activeLeftSnapshot = leftSnapshot?.skillId === selectedSkillId ? leftSnapshot : undefined;
  const activeRightSnapshot = rightSnapshot?.skillId === selectedSkillId ? rightSnapshot : undefined;
  const writableLibraries = skillLibraries.filter((library) => library.id !== BUILT_IN_SKILL_LIBRARY_ID);
  const targetLibrary = writableLibraries.find((library) => library.id === targetLibraryId);

  useEffect(() => {
    let active = true;
    const request = client.listSkillLibraries?.() ?? Promise.resolve([]);
    void request.then((libraries) => {
      if (!active) return;
      const writable = libraries.filter((library) => library.id !== BUILT_IN_SKILL_LIBRARY_ID);
      setSkillLibraries(libraries);
      setTargetLibraryId((current) => (
        writable.some((library) => library.id === current)
          ? current
          : writable.find((library) => library.id === DEFAULT_WRITABLE_SKILL_LIBRARY_ID)?.id
            ?? writable[0]?.id
            ?? DEFAULT_WRITABLE_SKILL_LIBRARY_ID
      ));
    }).catch(() => {
      // Publishing can still create the default writable library lazily.
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (selectedSkillId && catalog.includes(selectedSkillId)) return;
    setSelectedSkillId(catalog[0]);
  }, [catalog, selectedSkillId]);

  useEffect(() => {
    if (!visibleCatalog.length || visibleCatalog.includes(selectedSkillId ?? "")) return;
    setSelectedSkillId(visibleCatalog[0]);
  }, [selectedSkillId, visibleCatalog]);

  useEffect(() => {
    if (!selectedSkillId) return;
    let active = true;
    setVersionsSkillId(undefined);
    setVersions([]);
    setLeftVersionId(undefined);
    setRightVersionId(undefined);
    setLeftSnapshot(undefined);
    setRightSnapshot(undefined);
    setReviewDraftDetail(undefined);
    setReviewVersionId(undefined);
    setReviewFiles([]);
    setReviewFilesVersionId(undefined);
    setNewDraftPath("");
    setActivePath("SKILL.md");
    setLoadError(undefined);
    setGitUpdate(undefined);
    void client.listSkillVersions(selectedSkillId).then((next) => {
      if (!active) return;
      setVersions(next);
      setVersionsSkillId(selectedSkillId);
      const currentProposal = next.find((version) => version.kind === "agent-proposal" && version.current);
      const right = currentProposal ?? next[0];
      setRightVersionId(right?.id);
      setLeftVersionId(next.find((version) => version.id !== right?.id)?.id ?? right?.id);
      setReviewVersionId(currentProposal?.id);
      setMode("edit");
    }).catch((reason: Error) => {
      if (active) setLoadError(reason.message);
    });
    return () => { active = false; };
  }, [client, refreshKey, selectedSkillId]);

  useEffect(() => {
    if (!pendingDraft) {
      setReviewDraftDetail(undefined);
      return;
    }
    let active = true;
    void client.getSkillReviewDraft(pendingDraft.draftId).then((detail) => {
      if (active && detail.name === selectedSkillId) setReviewDraftDetail(detail);
    }).catch((reason: Error) => {
      if (active) setLoadError(reason.message);
    });
    return () => { active = false; };
  }, [client, pendingDraft?.draftId, refreshKey, selectedSkillId]);

  useEffect(() => {
    if (!selectedSkillId || !leftVersionId || versionsSkillId !== selectedSkillId
      || !versions.some((version) => version.id === leftVersionId)) return;
    let active = true;
    void client.getSkillVersion(selectedSkillId, leftVersionId).then((snapshot) => {
      if (active && snapshot.skillId === selectedSkillId) setLeftSnapshot(snapshot);
    }).catch((reason: Error) => {
      if (active) setLoadError(reason.message);
    });
    return () => { active = false; };
  }, [client, leftVersionId, selectedSkillId, versions, versionsSkillId]);

  useEffect(() => {
    if (!selectedSkillId || !rightVersionId || versionsSkillId !== selectedSkillId
      || !versions.some((version) => version.id === rightVersionId)) return;
    let active = true;
    void client.getSkillVersion(selectedSkillId, rightVersionId).then((snapshot) => {
      if (active && snapshot.skillId === selectedSkillId) setRightSnapshot(snapshot);
    }).catch((reason: Error) => {
      if (active) setLoadError(reason.message);
    });
    return () => { active = false; };
  }, [client, rightVersionId, selectedSkillId, versions, versionsSkillId]);

  useEffect(() => {
    if (!reviewVersionId || activeRightSnapshot?.id !== reviewVersionId
      || reviewFilesVersionId === reviewVersionId) return;
    setReviewFiles(activeRightSnapshot.files.map((file) => ({
      ...(file.binary ? { binary: true } : {}),
      content: file.content ?? "",
      ...(file.encodedContent === undefined ? {} : { encodedContent: file.encodedContent }),
      path: file.path,
    })).toSorted((left, right) => comparePaths(left.path, right.path)));
    setReviewFilesVersionId(reviewVersionId);
  }, [activeRightSnapshot, reviewFilesVersionId, reviewVersionId]);

  const leftByPath = useMemo(() => new Map(activeLeftSnapshot?.files.map((file) => [file.path, file]) ?? []), [activeLeftSnapshot]);
  const rightByPath = useMemo(() => new Map(activeRightSnapshot?.files.map((file) => [file.path, file]) ?? []), [activeRightSnapshot]);
  const reviewByPath = useMemo(() => new Map(reviewFiles.map((file) => [file.path, file])), [reviewFiles]);
  const editingDraft = Boolean(pendingDraft && mode === "edit" && reviewVersionId);
  const visibleRightByPath = editingDraft ? reviewByPath : rightByPath;
  const paths = useMemo(() => [...new Set([...leftByPath.keys(), ...visibleRightByPath.keys()])].toSorted(comparePaths), [leftByPath, visibleRightByPath]);
  const fileTree = useMemo(() => buildSkillFileTree(paths), [paths]);
  const leftFile = leftByPath.get(activePath);
  const rightFile = visibleRightByPath.get(activePath);
  const activeStatus = skillFileDiffStatus(leftFile, rightFile as EditableSkillFile | undefined);
  const reviewVersion = activeVersions.find((version) => version.id === reviewVersionId && version.kind === "agent-proposal");
  const reviewReady = Boolean(reviewDraftDetail && reviewVersion && reviewFilesVersionId === reviewVersionId);
  const confirmableReview = reviewReady && reviewFiles.some((file) => file.path === "SKILL.md" && !file.binary && file.content !== undefined);
  const installedCurrent = activeVersions.find((version) => version.kind === "managed-revision" && version.current);
  const installedGit = installedCurrent?.provenance?.git;
  const editable = selectedSkill?.source === "managed"
    && activeRightSnapshot?.id === installedCurrent?.id
    && Boolean(rightFile && !rightFile.binary);

  useEffect(() => {
    if (!paths.includes(activePath)) setActivePath(paths[0] ?? "");
  }, [activePath, paths]);

  useEffect(() => {
    const segments = activePath.split("/");
    if (segments.length < 2) return;
    setExpandedFolders((current) => {
      const next = new Set(current);
      let folder = "";
      for (const segment of segments.slice(0, -1)) {
        folder = folder ? `${folder}/${segment}` : segment;
        next.add(folder);
      }
      return next;
    });
  }, [activePath]);

  function toggleFolder(path: string): void {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderFileNodes(nodes: SkillFileTreeNode[], depth = 0): ReactNode {
    return nodes.map((node) => {
      if (node.kind === "directory") {
        const expanded = expandedFolders.has(node.path);
        return <div className="skill-file-tree-branch" key={node.path}>
          <button aria-expanded={expanded} className="skill-file-tree-folder" onClick={() => toggleFolder(node.path)} style={{ paddingInlineStart: 7 + depth * 14 }} title={node.path} type="button"><span className="skill-file-tree-copy"><ChevronRightIcon className={expanded ? "expanded" : undefined} size={12} /><ProjectIcon size={13} /><strong>{node.name}</strong></span><small>{node.fileCount}</small></button>
          {expanded ? <div className="skill-file-tree-children">{renderFileNodes(node.children, depth + 1)}</div> : null}
        </div>;
      }
      const status = skillFileDiffStatus(leftByPath.get(node.path), visibleRightByPath.get(node.path) as EditableSkillFile | undefined);
      return <button className={`skill-file-tree-file${node.path === activePath ? " active" : ""}`} key={node.path} onClick={() => setActivePath(node.path)} style={{ paddingInlineStart: 10 + depth * 14 }} title={node.path} type="button"><span className="skill-file-tree-copy"><FileIcon size={12} /><strong>{node.name}</strong></span><small className={status}>{status}</small></button>;
    });
  }

  useEffect(() => {
    if (!editingDraft) setEditContent(rightFile?.content ?? "");
  }, [activePath, editingDraft, rightFile?.content, rightVersionId]);

  function selectVersion(side: "left" | "right", id: string): void {
    setLoadError(undefined);
    setGitUpdate(undefined);
    if (side === "left") {
      setLeftVersionId(id);
      setLeftSnapshot(undefined);
    } else {
      setRightVersionId(id);
      setRightSnapshot(undefined);
    }
    setMode("compare");
  }

  function openEditMode(): void {
    if (pendingDraft) {
      const selectedReviewVersion = reviewVersion
        ?? activeVersions.find((version) => version.kind === "agent-proposal" && version.current)
        ?? activeVersions.find((version) => version.kind === "agent-proposal");
      if (selectedReviewVersion) selectReviewVersion(selectedReviewVersion.id);
      return;
    }
    if (installedCurrent) {
      setLoadError(undefined);
      setRightVersionId(installedCurrent.id);
      setRightSnapshot(undefined);
    }
    setMode("edit");
  }

  function selectReviewVersion(id: string): void {
    const version = activeVersions.find((candidate) => candidate.id === id && candidate.kind === "agent-proposal");
    if (!version) return;
    setLoadError(undefined);
    setReviewVersionId(id);
    setReviewFilesVersionId(undefined);
    setReviewFiles([]);
    setRightVersionId(id);
    setRightSnapshot(undefined);
    setActivePath("SKILL.md");
    setMode("edit");
  }

  function updateReviewFile(content: string): void {
    if (!activePath) return;
    setReviewFiles((current) => current.map((file) => file.path === activePath ? { ...file, content } : file));
  }

  function renameReviewFile(path: string): void {
    if (!activePath || path === activePath || reviewFiles.some((file) => file.path === path)) return;
    setReviewFiles((current) => current.map((file) => file.path === activePath ? { ...file, path } : file)
      .toSorted((left, right) => comparePaths(left.path, right.path)));
    setActivePath(path);
  }

  function addReviewFile(): void {
    const path = newDraftPath.trim();
    if (!path || reviewFiles.some((file) => file.path === path)) return;
    setReviewFiles((current) => [...current, { content: "", path }]
      .toSorted((left, right) => comparePaths(left.path, right.path)));
    setNewDraftPath("");
    setActivePath(path);
  }

  function removeReviewFile(): void {
    if (!activePath || activePath === "SKILL.md") return;
    setReviewFiles((current) => current.filter((file) => file.path !== activePath));
    setActivePath("SKILL.md");
  }

  async function confirmReviewVersion(): Promise<void> {
    if (!pendingDraft || !reviewDraftDetail || !reviewVersion || !confirmableReview) return;
    setBusy(true);
    setLoadError(undefined);
    try {
      await client.confirmSkillReviewDraft(pendingDraft.draftId, {
        expectedUpdatedAt: reviewDraftDetail.updatedAt,
        files: reviewFiles,
        libraryId: targetLibraryId,
        sourceVersionId: reviewVersion.id,
      });
      const [nextSkills, nextDrafts] = await Promise.all([
        client.listSkills(),
        client.listSkillReviewDrafts(),
      ]);
      onCatalogChange(nextSkills);
      onDraftsChange(nextDrafts);
      setReviewDraftDetail(undefined);
      setReviewVersionId(undefined);
      setReviewFiles([]);
      setReviewFilesVersionId(undefined);
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not confirm Skill proposal";
      setLoadError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  function openMergeDrafts(): void {
    const related = pendingDraft
      ? drafts.filter((draft) => draft.name === pendingDraft.name
        || draft.name.startsWith(`${pendingDraft.name}-`)
        || pendingDraft.name.startsWith(`${draft.name}-`))
      : [];
    const selected = related.length > 1 ? related : [];
    const target = selected.toSorted((left, right) => left.name.length - right.name.length || left.name.localeCompare(right.name))[0];
    setMergeSelectedIds(selected.map((draft) => draft.draftId));
    setMergeTargetId(target?.draftId);
    setMergeOpen(true);
  }

  function toggleMergeDraft(draftId: string): void {
    setMergeSelectedIds((current) => {
      if (current.includes(draftId)) {
        if (mergeTargetId === draftId) setMergeTargetId(undefined);
        return current.filter((id) => id !== draftId);
      }
      return [...current, draftId];
    });
  }

  async function mergeDrafts(): Promise<void> {
    if (!mergeTargetId || mergeSelectedIds.length < 2) return;
    setBusy(true);
    try {
      const merged = await client.mergeSkillReviewDrafts({
        draftIds: mergeSelectedIds,
        targetDraftId: mergeTargetId,
      });
      onDraftsChange(await client.listSkillReviewDrafts());
      setSelectedSkillId(merged.name);
      setMergeOpen(false);
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not combine Skill drafts");
    } finally {
      setBusy(false);
    }
  }

  async function saveFile(): Promise<void> {
    if (!selectedSkill || !editable || !activePath) return;
    setBusy(true);
    try {
      await client.updateSkillFile(selectedSkill.id, activePath, {
        content: editContent,
        expectedRevision: selectedSkill.currentRevision,
        ...(sessionId ? { sourceSessionId: sessionId } : {}),
      });
      onCatalogChange(await client.listSkills());
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not save Skill file");
    } finally {
      setBusy(false);
    }
  }

  async function checkGitUpdate(): Promise<void> {
    if (!installedGit) return;
    setBusy(true);
    setLoadError(undefined);
    try {
      const inspection = await client.inspectGitSkillRepository({
        ...(installedGit.ref ? { ref: installedGit.ref } : {}),
        repositoryUrl: installedGit.repositoryUrl,
        subdirectory: installedGit.subdirectory === "." ? undefined : installedGit.subdirectory,
      });
      const candidate = inspection.candidates.find((item) => item.subdirectory === installedGit.subdirectory)
        ?? inspection.candidates.find((item) => item.name === selectedSkillId);
      if (!candidate) throw new Error("The installed Skill path no longer exists in this repository");
      setGitUpdate({ candidate, inspection });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not check the Git Skill for updates");
    } finally {
      setBusy(false);
    }
  }

  async function prepareGitUpdate(): Promise<void> {
    if (!gitUpdate || gitUpdate.candidate.status !== "update") return;
    setBusy(true);
    try {
      await client.createGitSkillReviewDrafts({
        commit: gitUpdate.inspection.commit,
        ...(gitUpdate.inspection.ref ? { ref: gitUpdate.inspection.ref } : {}),
        repositoryUrl: gitUpdate.inspection.repositoryUrl,
        subdirectories: [gitUpdate.candidate.subdirectory],
      });
      onDraftsChange(await client.listSkillReviewDrafts());
      setGitUpdate(undefined);
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not prepare the Git Skill update");
    } finally {
      setBusy(false);
    }
  }

  function inspectDraftDeletion(): void {
    if (!pendingDraft) return;
    setDeleteConfirmation("");
    setDeleteTarget({ draftId: pendingDraft.draftId, id: pendingDraft.name, kind: "draft" });
  }

  async function inspectSkillDeletion(): Promise<void> {
    if (!selectedSkill || selectedSkill.source !== "managed" || pendingDraft) return;
    setBusy(true);
    try {
      const impact = await client.getSkillDeletionImpact(selectedSkill.id);
      setDeleteConfirmation("");
      setDeleteTarget({ id: selectedSkill.id, impact, kind: "skill" });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not inspect Skill references");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "skill"
      && (deleteTarget.impact.references.length || deleteConfirmation !== deleteTarget.id)) return;
    setBusy(true);
    try {
      const deletedId = deleteTarget.id;
      if (deleteTarget.kind === "draft") {
        await client.discardSkillReviewDraft(deleteTarget.draftId);
        onDraftsChange(await client.listSkillReviewDrafts());
      } else {
        await client.deleteSkill(deleteTarget.id);
        onCatalogChange(await client.listSkills());
      }
      setDeleteTarget(undefined);
      setDeleteConfirmation("");
      if (selectedSkillId === deletedId && (deleteTarget.kind === "skill" || !skills.some((skill) => skill.id === deletedId))) {
        setSelectedSkillId(catalog.find((id) => id !== deletedId));
      } else {
        setRefreshKey((current) => current + 1);
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : deleteTarget.kind === "draft" ? "Could not discard Skill draft" : "Could not delete Skill");
    } finally {
      setBusy(false);
    }
  }

  return <div className="dialog-backdrop">
    <section aria-label="Skill resource explorer" aria-modal="true" className="skill-workspace-dialog" role="dialog">
      <header className="skill-workspace-header">
        <div><span className="eyebrow">Skill workspace</span><h2>Skills Explorer</h2><p>Browse every package file, edit managed Skills, or compare any two saved versions.</p></div>
        <div className="skill-workspace-header-actions"><span><strong>{catalog.length}</strong> Skills</span><span className={drafts.length ? "has-drafts" : undefined}><strong>{drafts.length}</strong> Drafts</span><button aria-label="Close Skills Explorer" className="icon-button" onClick={onClose} type="button"><CloseIcon size={19} /></button></div>
      </header>
      <div className={`skill-workspace-layout${catalogCollapsed ? " catalog-collapsed" : ""}${filesCollapsed ? " files-collapsed" : ""}${historyCollapsed ? " history-collapsed" : ""}`}>
        <aside className={`skill-workspace-catalog${catalogCollapsed ? " collapsed" : ""}`}>
          <div className="skill-workspace-pane-title"><strong>Skills</strong><span>{visibleCatalog.length}</span><button aria-expanded={!catalogCollapsed} aria-label={catalogCollapsed ? "Expand Skills sidebar" : "Collapse Skills sidebar"} onClick={() => setCatalogCollapsed((current) => !current)} title={catalogCollapsed ? "Expand Skills" : "Collapse Skills"} type="button"><ChevronRightIcon className={!catalogCollapsed ? "skill-pane-chevron point-left" : "skill-pane-chevron"} size={14} /></button></div>
          {!catalogCollapsed ? <><label><input aria-label="Search Skill workspace" onChange={(event) => setQuery(event.target.value)} placeholder="Filter skills…" type="search" value={query} /></label>
          <div aria-label="Filter Skills" className="skill-workspace-filters" role="group"><button aria-pressed={catalogFilter === "all"} className={catalogFilter === "all" ? "active" : ""} onClick={() => setCatalogFilter("all")} type="button">All <span>{catalog.length}</span></button><button aria-pressed={catalogFilter === "drafts"} className={catalogFilter === "drafts" ? "active" : ""} onClick={() => setCatalogFilter("drafts")} type="button">Drafts <span>{draftNames.size}</span></button></div>
          {drafts.length > 1 ? <button className="skill-workspace-merge-trigger" onClick={openMergeDrafts} type="button">Combine drafts as versions</button> : null}
          <div className="skill-workspace-skill-list">{visibleCatalog.map((id) => {
            const descriptor = skills.find((skill) => skill.id === id);
            const pending = drafts.some((draft) => draft.name === id);
            return <button className={id === selectedSkillId ? "active" : ""} key={id} onClick={() => setSelectedSkillId(id)} type="button"><b aria-hidden="true" className={`skill-workspace-skill-icon ${descriptor?.source ?? "pending"}`}>{descriptor?.source === "built-in" ? "B" : pending && !descriptor ? "D" : "S"}</b><span><strong>{id}</strong><small>{descriptor?.source === "built-in" ? "Built-in · read-only" : descriptor ? `Managed · r${descriptor.currentRevision}` : "Pending Skill"}</small></span>{pending ? <i>Draft</i> : null}</button>;
          })}</div></> : null}
        </aside>
        <aside className={`skill-workspace-files${filesCollapsed ? " collapsed" : ""}`}>
          <div><strong>Package files</strong><span>{paths.length}</span><button aria-expanded={!filesCollapsed} aria-label={filesCollapsed ? "Expand package files sidebar" : "Collapse package files sidebar"} onClick={() => setFilesCollapsed((current) => !current)} title={filesCollapsed ? "Expand package files" : "Collapse package files"} type="button"><ChevronRightIcon className={!filesCollapsed ? "skill-pane-chevron point-left" : "skill-pane-chevron"} size={14} /></button></div>
          {!filesCollapsed ? <><nav aria-label="Skill package file tree" className="skill-file-tree">{renderFileNodes(fileTree)}</nav>{editingDraft ? <form className="skill-workspace-file-create" onSubmit={(event) => { event.preventDefault(); addReviewFile(); }}><input aria-label="New draft file path" onChange={(event) => setNewDraftPath(event.target.value)} placeholder="references/guide.md" spellCheck={false} value={newDraftPath} /><button aria-label="Add file to draft" disabled={!newDraftPath.trim() || reviewFiles.some((file) => file.path === newDraftPath.trim())} title="Add file" type="submit"><PlusIcon size={14} /></button></form> : null}</> : null}
        </aside>
        <main className="skill-workspace-main">
          <div className="skill-workspace-modebar">
            <div className="skill-workspace-mode-controls"><button className={mode === "compare" ? "active" : ""} disabled={activeVersions.length < 2} onClick={() => setMode("compare")} type="button">Compare</button><button className={mode === "edit" ? "active" : ""} disabled={!installedCurrent && !pendingDraft} onClick={openEditMode} type="button">{pendingDraft ? "Edit draft" : installedCurrent ? "Edit" : "Read-only"}</button></div>
            <strong title={`${selectedSkillId ?? ""}/${activePath}`}><span>{selectedSkillId}</span><b>/</b>{activePath || "Select a file"}</strong>
            <div className="skill-workspace-item-actions">
              {pendingDraft ? <button className="skill-workspace-focus-action" onClick={() => { const focused = catalogCollapsed && historyCollapsed; setCatalogCollapsed(!focused); setHistoryCollapsed(!focused); }} type="button">{catalogCollapsed && historyCollapsed ? "Show sidebars" : "Focus editor"}</button> : null}
              {installedGit ? <button disabled={busy} onClick={() => void checkGitUpdate()} title={`Check ${installedGit.repositoryUrl} at ${installedGit.ref ?? "the default branch"}`} type="button">{busy ? "Checking…" : "Check Git update"}</button> : null}
              {pendingDraft ? <button className="skill-workspace-delete-action" disabled={busy} onClick={inspectDraftDeletion} type="button">Discard draft</button> : null}
              {selectedSkill?.source === "managed" ? <button className="skill-workspace-delete-action" disabled={busy || Boolean(pendingDraft)} onClick={() => void inspectSkillDeletion()} title={pendingDraft ? "Discard the pending draft before deleting this Skill" : "Delete this managed Skill"} type="button">Delete Skill</button> : null}
              {selectedSkill?.source === "built-in" ? <span className="skill-workspace-protected">Protected</span> : null}
            </div>
          </div>
          <div className="skill-workspace-editor">
            {gitUpdate ? <div className={`skill-git-update-result ${gitUpdate.candidate.status}`}><div><strong>{gitUpdate.candidate.status === "update" ? "Update available" : gitUpdate.candidate.status === "unchanged" ? "Already up to date" : "Git source needs attention"}</strong><p><code>{gitUpdate.inspection.commit.slice(0, 12)}</code> · {gitUpdate.candidate.subdirectory}{gitUpdate.candidate.diagnostics.length ? ` · ${gitUpdate.candidate.diagnostics.join(" · ")}` : ""}</p></div><div><button onClick={() => setGitUpdate(undefined)} type="button">Dismiss</button>{gitUpdate.candidate.status === "update" ? <button className="primary-button" disabled={busy} onClick={() => void prepareGitUpdate()} type="button">Prepare review diff</button> : null}</div></div> : null}
            {loadError ? <div className="skill-workspace-load-error" role="alert"><strong>Could not load this Skill</strong><p>{loadError}</p><button onClick={() => setRefreshKey((current) => current + 1)} type="button">Retry</button></div> : !activeRightSnapshot ? <p className="skill-workspace-empty">Loading version…</p> : mode === "compare" ? leftFile?.binary || rightFile?.binary ? <div className="skill-workspace-empty"><strong>Binary comparison</strong><p>{leftFile?.size ?? 0} bytes → {rightByPath.get(activePath)?.size ?? 0} bytes</p></div> : <SkillLineDiff after={rightFile?.content} before={leftFile?.content} leftLabel={activeLeftSnapshot?.label ?? "Version A"} rightLabel={activeRightSnapshot.label} status={activeStatus} /> : pendingDraft ? !reviewReady ? <p className="skill-workspace-empty">Preparing the selected proposal…</p> : <div className="skill-workspace-draft-editor">
              <div className="skill-workspace-draft-path"><label><span>Package path</span><input defaultValue={activePath} disabled={activePath === "SKILL.md" || busy} key={activePath} onBlur={(event) => renameReviewFile(event.target.value.trim())} spellCheck={false} /></label>{activePath !== "SKILL.md" ? <button aria-label={`Remove ${activePath} from draft`} disabled={busy} onClick={removeReviewFile} title="Remove file" type="button"><TrashIcon size={15} /> Remove</button> : <span>Required entry file</span>}</div>
              {rightFile?.binary ? <div className="skill-binary-editor-note"><strong>Binary resource</strong><p>This file is preserved byte-for-byte. You can rename or remove it, but it cannot be edited as text.</p></div> : <textarea aria-label={`Edit draft file ${activePath}`} disabled={busy || !rightFile} onChange={(event) => updateReviewFile(event.target.value)} spellCheck={false} value={rightFile?.content ?? ""} />}
              <div className="skill-workspace-review-bar"><div><span><CheckIcon size={14} /> Review target</span><strong>{reviewVersion?.label}</strong><small>{versionSource(reviewVersion!)} · publishes an immutable library version</small></div><label className="skill-workspace-review-destination"><span>Publish to</span><select aria-label="Publish Skill draft to library" disabled={busy} onChange={(event) => setTargetLibraryId(event.target.value)} value={targetLibraryId}>{!writableLibraries.some((library) => library.id === DEFAULT_WRITABLE_SKILL_LIBRARY_ID) ? <option value={DEFAULT_WRITABLE_SKILL_LIBRARY_ID}>Project Skills · create on publish</option> : null}{writableLibraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label><button className="primary-button" disabled={busy || !confirmableReview} onClick={() => void confirmReviewVersion()} title={`Publish to ${targetLibrary?.name ?? "Project Skills"}`} type="button">{busy ? "Publishing…" : "Publish Skill"}</button></div>
            </div> : <>
              <textarea aria-label={`Edit Skill file ${activePath}`} disabled={!editable || busy} onChange={(event) => setEditContent(event.target.value)} spellCheck={false} value={editContent} />
              <div className="skill-workspace-save"><span>{selectedSkill?.source === "built-in" ? "Built-in Skills are read-only." : editable ? "Saving creates a new immutable revision." : "Choose the latest installed revision to edit."}</span><button className="primary-button" disabled={!editable || busy || editContent === rightFile?.content} onClick={() => void saveFile()} type="button">{busy ? "Saving…" : "Save new revision"}</button></div>
            </>}
          </div>
        </main>
        <aside className={`skill-workspace-history${historyCollapsed ? " collapsed" : ""}`}>
          <div className="skill-workspace-history-heading"><span><strong>Version history</strong><small>Choose A/B to compare · Review to publish</small></span><b>{activeVersions.length}</b><button aria-expanded={!historyCollapsed} aria-label={historyCollapsed ? "Expand version history sidebar" : "Collapse version history sidebar"} onClick={() => setHistoryCollapsed((current) => !current)} title={historyCollapsed ? "Expand version history" : "Collapse version history"} type="button"><ChevronRightIcon className={historyCollapsed ? "skill-pane-chevron point-left" : "skill-pane-chevron"} size={14} /></button></div>
          {!historyCollapsed ? <><ol>{activeVersions.map((version) => <li className={`${versionTone(version)}${leftVersionId === version.id || rightVersionId === version.id ? " selected-version" : ""}${reviewVersionId === version.id ? " review-target" : ""}`} key={version.id}><div><i /><span><strong>{version.label}</strong><small>{version.createdAt ? new Date(version.createdAt).toLocaleString() : "Packaged with this app"}</small><small className="skill-version-source">{versionSource(version)}</small>{version.provenance?.git ? <small className="skill-version-git-path" title={`${version.provenance.git.repositoryUrl}#${version.provenance.git.commit}`}>{version.provenance.git.subdirectory}</small> : null}{version.provenance?.sessionId && onOpenSession ? <button className="skill-version-session" onClick={() => onOpenSession(version.provenance!.sessionId!)} type="button">Open source Session ↗</button> : null}</span></div><div className="skill-version-actions"><span><button aria-label={`Select ${version.label} as version A`} className={leftVersionId === version.id ? "selected" : ""} onClick={() => selectVersion("left", version.id)} type="button">A</button><button aria-label={`Select ${version.label} as version B`} className={rightVersionId === version.id ? "selected" : ""} onClick={() => selectVersion("right", version.id)} type="button">B</button></span>{version.kind === "agent-proposal" ? <button aria-label={`Select ${version.label} as review target`} className={`skill-version-review-target${reviewVersionId === version.id ? " selected" : ""}`} onClick={() => selectReviewVersion(version.id)} type="button">{reviewVersionId === version.id ? <><CheckIcon size={12} /> Review target</> : "Review this version"}</button> : null}</div></li>)}</ol></> : null}
        </aside>
      </div>
      {mergeOpen ? <div className="skill-merge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMergeOpen(false); }}>
        <section aria-label="Combine Skill drafts as versions" aria-modal="true" className="skill-merge-dialog" role="dialog">
          <header><div><span className="eyebrow">Version management</span><h3>Combine drafts as versions</h3><p>Select related drafts and choose the stable Skill name. Their proposals will be ordered into one version history.</p></div><button aria-label="Close combine drafts dialog" className="icon-button" disabled={busy} onClick={() => setMergeOpen(false)} type="button"><CloseIcon size={17} /></button></header>
          <div className="skill-merge-list">{drafts.map((draft) => {
            const selected = mergeSelectedIds.includes(draft.draftId);
            return <div className={selected ? "selected" : ""} key={draft.draftId}><label><input checked={selected} onChange={() => toggleMergeDraft(draft.draftId)} type="checkbox" /><span><strong>{draft.name}</strong><small>{draft.comparisonSource === "previous-agent-draft" ? "Contains proposal history" : "Pending Skill draft"}</small></span></label><label className="skill-merge-primary"><input checked={mergeTargetId === draft.draftId} disabled={!selected} name="primary-skill-draft" onChange={() => setMergeTargetId(draft.draftId)} type="radio" />Primary name</label></div>;
          })}</div>
          <p className="skill-merge-note">Only uninstalled drafts can be combined. The selected primary name becomes the stable identity; variant names are rewritten inside each proposal.</p>
          <footer><button className="secondary-button" disabled={busy} onClick={() => setMergeOpen(false)} type="button">Cancel</button><button className="primary-button" disabled={busy || mergeSelectedIds.length < 2 || !mergeTargetId} onClick={() => void mergeDrafts()} type="button">{busy ? "Combining…" : `Combine ${mergeSelectedIds.length} drafts`}</button></footer>
        </section>
      </div> : null}
      {deleteTarget ? <div className="skill-merge-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(undefined); }}>
        <section aria-label={deleteTarget.kind === "draft" ? `Discard Skill draft ${deleteTarget.id}` : `Delete Skill ${deleteTarget.id}`} aria-modal="true" className="skill-workspace-delete-dialog" role="dialog">
          <header><div><span className="eyebrow">{deleteTarget.kind === "draft" ? "Pending draft" : "Managed Skill"}</span><h3>{deleteTarget.kind === "draft" ? `Discard “${deleteTarget.id}”?` : `Delete “${deleteTarget.id}”?`}</h3><p>{deleteTarget.kind === "draft" ? "This removes the unconfirmed Agent proposal. Any installed revision of the Skill is kept." : "Deletion is limited to user-managed Skills. Built-in packages remain protected."}</p></div><button aria-label="Close delete Skill dialog" className="icon-button" disabled={busy} onClick={() => setDeleteTarget(undefined)} type="button"><CloseIcon size={17} /></button></header>
          <div className="skill-workspace-delete-content">
            {deleteTarget.kind === "draft" ? <div className="skill-workspace-delete-warning"><strong>This action cannot be undone</strong><p>The draft and its unconfirmed proposal history will be removed.</p></div> : deleteTarget.impact.references.length ? <><div className="skill-workspace-delete-blocked"><strong>This Skill is still in use</strong><p>Remove it from the settings below before trying again.</p></div><ul>{deleteTarget.impact.references.map((reference) => <li key={`${reference.scope}-${reference.id}`}><span>{reference.scope}</span><strong>{reference.label}</strong></li>)}</ul></> : <><p>This removes the Skill from the active catalog. Historical run manifests keep their recorded revision and hash.</p><label><span>Type <code>{deleteTarget.id}</code> to confirm</span><input autoFocus onChange={(event) => setDeleteConfirmation(event.target.value)} spellCheck={false} value={deleteConfirmation} /></label></>}
          </div>
          <footer><button className="secondary-button" disabled={busy} onClick={() => setDeleteTarget(undefined)} type="button">Cancel</button>{deleteTarget.kind === "draft" ? <button className="danger-button" disabled={busy} onClick={() => void confirmDeletion()} type="button">{busy ? "Discarding…" : "Discard draft"}</button> : !deleteTarget.impact.references.length ? <button className="danger-button" disabled={busy || deleteConfirmation !== deleteTarget.id} onClick={() => void confirmDeletion()} type="button">{busy ? "Deleting…" : "Delete Skill"}</button> : null}</footer>
        </section>
      </div> : null}
    </section>
  </div>;
}
