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

import React, { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  CreateSkillPackageRequest,
  GitSkillRepositoryInspection,
  SkillLibrary,
  SkillLibraryDiff,
  SkillLibraryUpdateProposal,
  SkillLibraryVersion,
  SkillDescriptor,
  SkillReviewDraftSummary,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon, PlusIcon, TrashIcon } from "./icons.js";
import { createSkillFolderArchive } from "./skill-folder-import.js";
import { SkillWorkspaceDialog } from "./SkillWorkspaceDialog.js";

export interface SkillEditorDraft {
  allowedTools: string;
  compatibility: string;
  description: string;
  instructions: string;
  license: string;
  metadata: Record<string, string>;
  name: string;
  resources?: SkillEditorResourceDraft[];
  version: string;
}

export interface SkillEditorResourceDraft {
  content: string;
  id: number;
  path: string;
}

interface GitImportLocation {
  ref: string;
  repositoryUrl: string;
  subdirectory: string;
}

const EMPTY_DRAFT: SkillEditorDraft = {
  allowedTools: "",
  compatibility: "",
  description: "",
  instructions: "# Instructions\n\n",
  license: "",
  metadata: {},
  name: "",
  resources: [],
  version: "",
};

export function normalizeGitSkillLocation(input: GitImportLocation): GitImportLocation & { adapted: boolean } {
  const repositoryUrl = input.repositoryUrl.trim();
  try {
    const parsed = new URL(repositoryUrl);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (parsed.protocol !== "https:" || !new Set(["github.com", "www.github.com"]).has(host)
      || segments.length < 4 || segments[2] !== "tree") {
      return { ...input, repositoryUrl, adapted: false };
    }
    const repositoryName = segments[1]!.replace(/\.git$/, "");
    return {
      adapted: true,
      ref: input.ref.trim() || segments[3]!,
      repositoryUrl: `https://github.com/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(repositoryName)}.git`,
      subdirectory: input.subdirectory.trim() || segments.slice(4).join("/"),
    };
  } catch {
    return { ...input, repositoryUrl, adapted: false };
  }
}

function resourceValidationError(resources: SkillEditorResourceDraft[]): string | undefined {
  const paths = new Set<string>();
  for (const resource of resources) {
    const path = resource.path.trim();
    if (!path) return "Every resource needs a relative package path.";
    if (path === "SKILL.md") return "SKILL.md is generated from the Skill details and cannot be added as a resource.";
    if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return `Resource path must be a safe relative path: ${path}`;
    }
    if (paths.has(path)) return `Resource path is duplicated: ${path}`;
    paths.add(path);
  }
  return undefined;
}

export function validateSkillDraft(draft: SkillEditorDraft): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) || draft.name.length > 64) {
    return "Name must use 1–64 lowercase letters, digits, or single hyphens.";
  }
  const description = draft.description.trim();
  if (!description || description.length > 1024) return "Description must contain 1–1024 characters.";
  if (!draft.instructions.trim()) return "Markdown instructions are required.";
  if (draft.compatibility.trim().length > 500) return "Compatibility must be at most 500 characters.";
  return resourceValidationError(draft.resources ?? []);
}

export function requestFromDraft(draft: SkillEditorDraft): CreateSkillPackageRequest {
  const metadata = { ...draft.metadata };
  if (draft.version.trim()) metadata.version = draft.version.trim();
  else delete metadata.version;
  return {
    ...(draft.allowedTools.trim() ? { allowedTools: draft.allowedTools.trim() } : {}),
    ...(draft.compatibility.trim() ? { compatibility: draft.compatibility.trim() } : {}),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    ...(draft.license.trim() ? { license: draft.license.trim() } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    name: draft.name.trim(),
    ...((draft.resources?.length ?? 0) ? {
      resources: draft.resources!.map((resource) => ({ content: resource.content, path: resource.path.trim() })),
    } : {}),
  };
}

export function SkillManager({
  client,
  initialView = "skills",
  onCatalogChange,
  onDistillSession,
  onError,
  onOpenSession,
  onStartSkillCreation,
  onWorkspaceLaunchHandled,
  sessionId,
  skills,
  workspaceLaunch,
}: {
  client: ApiClient;
  initialView?: "libraries" | "skills";
  onCatalogChange: (skills: SkillDescriptor[]) => void;
  onDistillSession?: () => void;
  onError: (message: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onStartSkillCreation?: () => void;
  onWorkspaceLaunchHandled?: (requestId: number) => void;
  sessionId?: string;
  skills: SkillDescriptor[];
  workspaceLaunch?: { requestId: number; skillId?: string };
}) {
  const [view, setView] = useState<"libraries" | "skills">(initialView);

  if (view === "libraries") {
    return <div className="skill-manager">
      <SkillLibraryManager client={client} onError={onError} onViewChange={setView} />
    </div>;
  }

  return <div className="skill-manager">
    <SkillCatalogManager
      client={client}
      onCatalogChange={onCatalogChange}
      onDistillSession={onDistillSession}
      onError={onError}
      onOpenSession={onOpenSession}
      onStartSkillCreation={onStartSkillCreation}
      onViewChange={setView}
      onWorkspaceLaunchHandled={onWorkspaceLaunchHandled}
      sessionId={sessionId}
      skills={skills}
      workspaceLaunch={workspaceLaunch}
    />
  </div>;
}

function SkillManagerViewTabs({
  activeView,
  onViewChange,
}: {
  activeView: "libraries" | "skills";
  onViewChange: (view: "libraries" | "skills") => void;
}) {
  return <div aria-label="Skill manager views" className="skill-manager-tabs" role="tablist">
    <button aria-selected={activeView === "skills"} className={activeView === "skills" ? "active" : ""} onClick={() => onViewChange("skills")} role="tab" type="button">Skills</button>
    <button aria-selected={activeView === "libraries"} className={activeView === "libraries" ? "active" : ""} onClick={() => onViewChange("libraries")} role="tab" type="button">Libraries</button>
  </div>;
}

function SkillCatalogManager({
  client,
  onCatalogChange,
  onDistillSession,
  onError,
  onOpenSession,
  onStartSkillCreation,
  onViewChange,
  onWorkspaceLaunchHandled,
  sessionId,
  skills,
  workspaceLaunch,
}: {
  client: ApiClient;
  onCatalogChange: (skills: SkillDescriptor[]) => void;
  onDistillSession?: () => void;
  onError: (message: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onStartSkillCreation?: () => void;
  onViewChange: (view: "libraries" | "skills") => void;
  onWorkspaceLaunchHandled?: (requestId: number) => void;
  sessionId?: string;
  skills: SkillDescriptor[];
  workspaceLaunch?: { requestId: number; skillId?: string };
}) {
  const [query, setQuery] = useState("");
  const [editorMode, setEditorMode] = useState<"create">();
  const [editorSection, setEditorSection] = useState<"details" | "resources">("details");
  const [draft, setDraft] = useState<SkillEditorDraft>(EMPTY_DRAFT);
  const [authoringMode, setAuthoringMode] = useState<"git">();
  const [gitImport, setGitImport] = useState({ ref: "", repositoryUrl: "", subdirectory: "" });
  const [gitLinkNotice, setGitLinkNotice] = useState<string>();
  const [gitInspection, setGitInspection] = useState<GitSkillRepositoryInspection>();
  const [gitSelected, setGitSelected] = useState<string[]>([]);
  const [draftSourceSummary, setDraftSourceSummary] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [reviewDrafts, setReviewDrafts] = useState<SkillReviewDraftSummary[]>([]);
  const [workspaceSkillId, setWorkspaceSkillId] = useState<string>();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importFolderInput = useRef<HTMLInputElement>(null);
  const nextResourceId = useRef(1);

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalized))
      : skills;
  }, [query, skills]);

  useEffect(() => {
    let active = true;
    async function refreshPending(): Promise<void> {
      try {
        const next = await client.listSkillReviewDrafts();
        if (!active) return;
        setReviewDrafts(next);
      } catch (reason) {
        if (active) onError(reason instanceof Error ? reason.message : "Could not load pending Skill drafts");
      }
    }
    void refreshPending();
    const interval = globalThis.setInterval(() => void refreshPending(), 3_000);
    return () => { active = false; globalThis.clearInterval(interval); };
  }, [client, onError]);

  useEffect(() => {
    if (!workspaceLaunch) return;
    const { requestId, skillId } = workspaceLaunch;
    let active = true;
    setBusy(true);
    setLocalError(undefined);
    void client.listSkillReviewDrafts().then((next) => {
      if (!active) return;
      setReviewDrafts(next);
      setWorkspaceSkillId(skillId);
      setWorkspaceOpen(true);
    }).catch((reason) => {
      if (!active) return;
      const message = reason instanceof Error ? reason.message : "Could not open the generated Skill draft";
      setLocalError(message);
      onError(message);
      setWorkspaceSkillId(undefined);
      setWorkspaceOpen(true);
    }).finally(() => {
      if (!active) return;
      setBusy(false);
      onWorkspaceLaunchHandled?.(requestId);
    });
    return () => { active = false; };
  }, [client, onError, workspaceLaunch?.requestId]);

  async function refreshCatalog(): Promise<void> {
    const next = await client.listSkills();
    onCatalogChange(next);
  }

  async function refreshReviewDrafts(): Promise<void> {
    setReviewDrafts(await client.listSkillReviewDrafts());
  }

  function openCreate(): void {
    setDraft({ ...EMPTY_DRAFT, resources: [] });
    setLocalError(undefined);
    setEditorMode("create");
    setEditorSection("details");
    setDraftSourceSummary(undefined);
  }

  function addResource(kind: "other" | "reference" | "script"): void {
    const resources = draft.resources ?? [];
    const defaults = kind === "reference"
      ? { content: "# Reference\n\n", path: "references/guide.md" }
      : kind === "script"
        ? { content: "# Helper script\n", path: "scripts/helper.py" }
        : { content: "", path: "resources/notes.md" };
    const extensionIndex = defaults.path.lastIndexOf(".");
    const base = extensionIndex < 0 ? defaults.path : defaults.path.slice(0, extensionIndex);
    const extension = extensionIndex < 0 ? "" : defaults.path.slice(extensionIndex);
    let path = defaults.path;
    let suffix = 2;
    const existing = new Set(resources.map((resource) => resource.path.trim()));
    while (existing.has(path)) {
      path = `${base}-${suffix}${extension}`;
      suffix += 1;
    }
    setDraft((current) => ({
      ...current,
      resources: [...(current.resources ?? []), { ...defaults, id: nextResourceId.current++, path }],
    }));
    setEditorSection("resources");
  }

  function updateResource(id: number, patch: Partial<Pick<SkillEditorResourceDraft, "content" | "path">>): void {
    setDraft((current) => ({
      ...current,
      resources: (current.resources ?? []).map((resource) => resource.id === id ? { ...resource, ...patch } : resource),
    }));
  }

  function removeResource(id: number): void {
    setDraft((current) => ({
      ...current,
      resources: (current.resources ?? []).filter((resource) => resource.id !== id),
    }));
  }

  function adaptGitLocation(): GitImportLocation {
    const normalized = normalizeGitSkillLocation(gitImport);
    if (normalized.adapted) {
      setGitImport({ ref: normalized.ref, repositoryUrl: normalized.repositoryUrl, subdirectory: normalized.subdirectory });
      setGitLinkNotice(`GitHub folder link recognized · ${normalized.ref || "default branch"}${normalized.subdirectory ? ` / ${normalized.subdirectory}` : ""}`);
    }
    return normalized;
  }

  function openWorkspace(skillId?: string): void {
    setWorkspaceSkillId(skillId);
    setWorkspaceOpen(true);
  }

  async function inspectGitRepository(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setLocalError(undefined);
    try {
      const location = adaptGitLocation();
      const inspected = await client.inspectGitSkillRepository({
        ...(location.ref.trim() ? { ref: location.ref.trim() } : {}),
        repositoryUrl: location.repositoryUrl.trim(),
        ...(location.subdirectory.trim() ? { subdirectory: location.subdirectory.trim() } : {}),
      });
      setGitInspection(inspected);
      setGitSelected(inspected.candidates
        .filter((candidate) => candidate.status === "new" || candidate.status === "update")
        .map((candidate) => candidate.subdirectory));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not inspect Git repository";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function createGitReviewDrafts(): Promise<void> {
    if (!gitInspection || !gitSelected.length) return;
    setBusy(true);
    setLocalError(undefined);
    try {
      await client.createGitSkillReviewDrafts({
        commit: gitInspection.commit,
        ...(gitInspection.ref ? { ref: gitInspection.ref } : {}),
        repositoryUrl: gitInspection.repositoryUrl,
        subdirectories: gitSelected,
      });
      await refreshReviewDrafts();
      setAuthoringMode(undefined);
      setGitInspection(undefined);
      setWorkspaceOpen(true);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not prepare Git Skill updates";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSkill(event: FormEvent): Promise<void> {
    event.preventDefault();
    const validation = validateSkillDraft(draft);
    if (validation) {
      setLocalError(validation);
      if (resourceValidationError(draft.resources ?? [])) setEditorSection("resources");
      else setEditorSection("details");
      return;
    }
    setBusy(true);
    setLocalError(undefined);
    try {
      const request = requestFromDraft(draft);
      const saved = await client.createSkill({ ...request, ...(sessionId ? { sourceSessionId: sessionId } : {}) });
      await refreshCatalog();
      setEditorMode(undefined);
      openWorkspace(saved.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not save skill";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function importSkill(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    setLocalError(undefined);
    try {
      const imported = await client.importSkill(file);
      await refreshCatalog();
      openWorkspace(imported.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not import skill";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function importSkillFolder(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    setBusy(true);
    setLocalError(undefined);
    try {
      const archive = await createSkillFolderArchive(Array.from(files));
      const imported = await client.importSkill(archive);
      await refreshCatalog();
      openWorkspace(imported.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not import skill folder";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
      if (importFolderInput.current) importFolderInput.current.value = "";
    }
  }

  return <div className="skill-catalog-manager">
    <section className="skill-manager-hero">
      <div><span className="eyebrow">Agent Skills</span><h3>Skill manager</h3></div>
      <div className="skill-manager-hero-actions">
        <SkillManagerViewTabs activeView="skills" onViewChange={onViewChange} />
        <div aria-label="Skill catalog summary" className="skill-manager-stats">
          <span><strong>{skills.length}</strong><small>Installed</small></span>
          <span><strong>{skills.filter((skill) => skill.source === "managed").length}</strong><small>Managed</small></span>
          <span className={reviewDrafts.length ? "has-pending" : undefined}><strong>{reviewDrafts.length}</strong><small>Awaiting review</small></span>
        </div>
      </div>
    </section>
    <div className="skill-manager-toolbar">
      <label className="skill-search-field"><span aria-hidden="true">⌕</span><input aria-label="Search skills" onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or description" type="search" value={query} /></label>
      <button className="skill-explorer-button" disabled={busy} onClick={() => openWorkspace()} type="button">Open Skills Explorer</button>
      <details className="skill-toolbar-menu" name="skill-actions">
        <summary aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>Create Skill <span aria-hidden="true" className="skill-toolbar-chevron"><ChevronDownIcon size={15} /></span></summary>
        <div className="skill-toolbar-popover">
          <span className="skill-toolbar-popover-label">Create</span>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreate(); }} type="button"><span className="skill-action-icon">＋</span><span><strong>Blank Skill</strong><small>Start with an editable SKILL.md</small></span></button>
          <button disabled={busy || !onStartSkillCreation} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onStartSkillCreation?.(); }} type="button"><span className="skill-action-icon">✦</span><span><strong>Describe workflow</strong><small>Continue with /skill-creator in a new Session</small></span></button>
          <button disabled={busy || !sessionId || !onDistillSession} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDistillSession?.(); }} title={sessionId ? "Continue with /distill-session in the active Session" : "Open a Session first"} type="button"><span className="skill-action-icon">◇</span><span><strong>Distill current Session</strong><small>Turn this conversation into a reviewable Skill</small></span></button>
        </div>
      </details>
      <details className="skill-toolbar-menu skill-import-menu" name="skill-actions">
        <summary aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>Import <span aria-hidden="true" className="skill-toolbar-chevron"><ChevronDownIcon size={15} /></span></summary>
        <div className="skill-toolbar-popover">
          <span className="skill-toolbar-popover-label">Import from</span>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importInput.current?.click(); }} type="button"><span className="skill-action-icon">↥</span><span><strong>SKILL.md or ZIP</strong><small>Choose a single package file</small></span></button>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importFolderInput.current?.click(); }} type="button"><span className="skill-action-icon">□</span><span><strong>Folder</strong><small>Import a complete local directory</small></span></button>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setAuthoringMode("git"); setGitImport({ ref: "", repositoryUrl: "", subdirectory: "" }); setGitInspection(undefined); setGitLinkNotice(undefined); }} type="button"><span className="skill-action-icon">⑂</span><span><strong>Git repository</strong><small>Paste a repository or marketplace folder link</small></span></button>
        </div>
      </details>
      <input accept=".md,.zip,text/markdown,application/zip" aria-label="Import SKILL.md or ZIP" className="visually-hidden" onChange={(event) => void importSkill(event.target.files?.[0])} ref={importInput} type="file" />
      <input {...{ webkitdirectory: "" }} aria-label="Import skill folder" className="visually-hidden" multiple onChange={(event) => void importSkillFolder(event.target.files)} ref={importFolderInput} type="file" />
    </div>
    {reviewDrafts.length ? <section className="skill-review-queue"><span aria-hidden="true" className="skill-review-queue-icon">!</span><div><strong>{reviewDrafts.length} pending review{reviewDrafts.length === 1 ? "" : "s"}</strong><p>Review drafts and proposal history in the dedicated Explorer.</p></div><button disabled={busy} onClick={() => openWorkspace(reviewDrafts[0]?.name)} type="button">Open review workspace <span>{reviewDrafts.length}</span></button></section> : null}
    {authoringMode === "git" ? <form className="skill-authoring-panel skill-git-import-panel" onSubmit={(event) => void inspectGitRepository(event)}>
      <div className="skill-authoring-heading"><div><span className="eyebrow">Git source</span><h4>Scan a Skill repository</h4></div>{gitInspection ? <span className="skill-git-commit" title={gitInspection.commit}>commit {gitInspection.commit.slice(0, 12)}</span> : null}</div>
      <label><span>Repository or marketplace folder URL</span><input autoFocus onBlur={adaptGitLocation} onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, repositoryUrl: event.target.value })); }} placeholder="https://github.com/org/repo/tree/main/skills" required value={gitImport.repositoryUrl} /></label>
      {gitLinkNotice ? <div className="skill-git-link-notice"><span aria-hidden="true">✓</span><div><strong>GitHub link adapted</strong><small>{gitLinkNotice}</small></div></div> : null}
      <div className="skill-editor-columns"><label><span>Ref (optional)</span><input onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, ref: event.target.value })); }} placeholder="main, a tag, or a branch" value={gitImport.ref} /></label><label><span>Search path (optional)</span><input onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, subdirectory: event.target.value })); }} placeholder="skills/my-skill" value={gitImport.subdirectory} /></label></div>
      <p>Repository roots, marketplace directories, and direct Skill paths are supported. GitHub <code>/tree/ref/path</code> links automatically fill the repository, ref, and search path. The exact commit is saved with every confirmed version.</p>
      {gitInspection ? <fieldset className="skill-git-candidates"><legend>Select Skill packages</legend>{gitInspection.candidates.map((candidate) => {
        const selectable = candidate.status === "new" || candidate.status === "update";
        const selected = gitSelected.includes(candidate.subdirectory);
        return <label className={`skill-git-candidate ${candidate.status}`} key={candidate.subdirectory}>
          <input checked={selected} disabled={!selectable || busy} onChange={(event) => setGitSelected((current) => event.target.checked ? [...current, candidate.subdirectory] : current.filter((path) => path !== candidate.subdirectory))} type="checkbox" />
          <span className="skill-git-candidate-copy"><strong>{candidate.name ?? candidate.subdirectory}</strong><small>{candidate.subdirectory}{candidate.description ? ` · ${candidate.description}` : ""}</small>{candidate.diagnostics.length ? <em>{candidate.diagnostics.join(" · ")}</em> : null}</span>
          <span className={`skill-git-status ${candidate.status}`}>{candidate.status === "update" ? `Update r${candidate.currentRevision}` : candidate.status}</span>
        </label>;
      })}</fieldset> : null}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => { setAuthoringMode(undefined); setGitInspection(undefined); }} type="button">Cancel</button>{gitInspection ? <><button className="secondary-button" disabled={busy} type="submit">Scan again</button><button className="primary-button" disabled={busy || !gitSelected.length} onClick={() => void createGitReviewDrafts()} type="button">Review {gitSelected.length} selected update{gitSelected.length === 1 ? "" : "s"}</button></> : <button className="primary-button" disabled={busy} type="submit">Scan repository</button>}</div>
    </form> : null}
    {localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}
    <section aria-label="Skill catalog" className="skill-library-panel">
      <header className="skill-library-heading"><div><strong>Skill library</strong><small>{query ? `${visibleSkills.length} results` : `${skills.length} available Skills`}</small></div><span>Select a Skill to open its files and history</span></header>
      <div className="skill-library-list">
        {visibleSkills.map((skill) => <button aria-label={`Open ${skill.name} in Skills Explorer`} className="skill-card" key={skill.id} onClick={() => openWorkspace(skill.id)} title={`Open ${skill.name} in Skills Explorer`} type="button">
          <span aria-hidden="true" className={`skill-card-icon ${skill.source}`}>{skill.source === "built-in" ? "B" : "S"}</span>
          <span className="skill-card-copy"><strong>{skill.name}</strong><small>{skill.description}</small><span className="skill-card-metadata"><span>v{skill.version}</span><span>{skill.resourceSummary.files} supporting file{skill.resourceSummary.files === 1 ? "" : "s"}</span></span></span>
          <span className={`skill-source ${skill.source}`}>{skill.source === "built-in" ? "Built-in · read-only" : `Managed · r${skill.currentRevision}`}</span>
          <span aria-hidden="true" className="skill-card-open"><span>Open</span><ChevronRightIcon size={17} /></span>
        </button>)}
        {!visibleSkills.length ? <div className="skill-library-empty"><span aria-hidden="true">⌕</span><strong>No matching Skills</strong><p>Try another name or description.</p></div> : null}
      </div>
    </section>

    {editorMode ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditorMode(undefined); }}>
      <section aria-label="Create skill" aria-modal="true" className="skill-editor-dialog" role="dialog">
        <header className="skill-editor-header"><div><span className="eyebrow">Agent Skills format</span><h2>Create skill</h2><p>Author the instructions and package supporting resources together.</p></div><button aria-label="Close create Skill dialog" className="icon-button" disabled={busy} onClick={() => setEditorMode(undefined)} type="button"><CloseIcon size={18} /></button></header>
        <form onSubmit={(event) => void saveSkill(event)}>
          <nav aria-label="Create Skill sections" className="skill-editor-tabs"><button className={editorSection === "details" ? "active" : ""} onClick={() => setEditorSection("details")} type="button"><strong>Skill details</strong><small>SKILL.md</small></button><button className={editorSection === "resources" ? "active" : ""} onClick={() => setEditorSection("resources")} type="button"><strong>Resources</strong><small>{draft.resources?.length ?? 0}</small></button></nav>
          <div className="skill-editor-body">
            {draftSourceSummary ? <p className="skill-preservation-note">{draftSourceSummary} This draft is inactive until you save it.</p> : null}
            {editorSection === "details" ? <div className="skill-editor-details">
              <label><span>Name</span><input autoFocus disabled={busy} maxLength={64} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="literature-review" required value={draft.name} /></label>
              <label><span>Description</span><textarea maxLength={1024} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} required rows={3} value={draft.description} /></label>
              <div className="skill-editor-columns"><label><span>License (optional)</span><input onChange={(event) => setDraft((current) => ({ ...current, license: event.target.value }))} value={draft.license} /></label><label><span>Version (optional)</span><input onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} placeholder="1.0.0" value={draft.version} /></label></div>
              <label><span>Compatibility (optional)</span><input maxLength={500} onChange={(event) => setDraft((current) => ({ ...current, compatibility: event.target.value }))} value={draft.compatibility} /></label>
              <label><span>Allowed tools (preserved, not enforced)</span><input onChange={(event) => setDraft((current) => ({ ...current, allowedTools: event.target.value }))} value={draft.allowedTools} /></label>
              <label><span>Markdown instructions</span><textarea className="skill-markdown-editor" onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} required rows={12} value={draft.instructions} /></label>
            </div> : <div className="skill-resource-authoring">
              <header><div><strong>Package resources</strong><p>Add portable text files that ship with this Skill. Use conventional folders so Agents can disclose them progressively.</p></div><div><button onClick={() => addResource("reference")} type="button"><PlusIcon size={14} /> Reference</button><button onClick={() => addResource("script")} type="button"><PlusIcon size={14} /> Script</button><button onClick={() => addResource("other")} type="button"><PlusIcon size={14} /> Other file</button></div></header>
              {(draft.resources?.length ?? 0) ? <div className="skill-resource-authoring-list">{draft.resources!.map((resource, index) => {
                const kind = resource.path.startsWith("references/") ? "Reference" : resource.path.startsWith("scripts/") ? "Script" : resource.path.startsWith("assets/") ? "Asset" : "Resource";
                return <article key={resource.id}><header><span aria-hidden="true"><FileIcon size={16} /></span><label><span>{kind} {index + 1}</span><input aria-label={`Resource ${index + 1} path`} onChange={(event) => updateResource(resource.id, { path: event.target.value })} placeholder="references/guide.md" spellCheck={false} value={resource.path} /></label><button aria-label={`Remove resource ${resource.path || index + 1}`} onClick={() => removeResource(resource.id)} title="Remove resource" type="button"><TrashIcon size={16} /></button></header><label><span>Text content</span><textarea aria-label={`Resource ${index + 1} content`} className="skill-resource-content-editor" onChange={(event) => updateResource(resource.id, { content: event.target.value })} rows={9} spellCheck={false} value={resource.content} /></label></article>;
              })}</div> : <div className="skill-resource-authoring-empty"><span aria-hidden="true"><FileIcon size={24} /></span><strong>No supporting resources yet</strong><p>Add a reference, helper script, or another text file. For binary assets, use folder or ZIP import.</p><button onClick={() => addResource("reference")} type="button"><PlusIcon size={15} /> Add your first reference</button></div>}
            </div>}
          </div>
          <div className="skill-editor-error-slot">{localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}</div>
          <footer><span>{draft.resources?.length ?? 0} supporting resource{(draft.resources?.length ?? 0) === 1 ? "" : "s"} will be packaged</span><div><button className="secondary-button" disabled={busy} onClick={() => setEditorMode(undefined)} type="button">Cancel</button><button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : "Create skill"}</button></div></footer>
        </form>
      </section>
    </div> : null}

    {workspaceOpen ? <SkillWorkspaceDialog client={client} drafts={reviewDrafts} initialSkillId={workspaceSkillId} onCatalogChange={onCatalogChange} onClose={() => { setWorkspaceOpen(false); setWorkspaceSkillId(undefined); }} onDraftsChange={setReviewDrafts} onError={onError} onOpenSession={onOpenSession} sessionId={sessionId} skills={skills} /> : null}
  </div>;
}

const DEFAULT_LIBRARY_SKILL = "---\nname: evaluated-skill\ndescription: Skill package committed from the library manager.\nmetadata:\n  version: 0.1.0\n---\n\n# Evaluated skill\n\nDescribe the reusable workflow here.\n";

function skillLibraryPackage(markdown: string) {
  return { files: [{ content: markdown, path: "SKILL.md" }] };
}

function diffCount(diff?: SkillLibraryDiff): number {
  return (diff?.added.length ?? 0) + (diff?.deleted.length ?? 0) + (diff?.modified.length ?? 0);
}

function SkillLibraryManager({
  client,
  onError,
  onViewChange,
}: {
  client: ApiClient;
  onError: (message: string) => void;
  onViewChange: (view: "libraries" | "skills") => void;
}) {
  const [libraries, setLibraries] = useState<SkillLibrary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [versions, setVersions] = useState<SkillLibraryVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [fromVersionId, setFromVersionId] = useState("");
  const [toVersionId, setToVersionId] = useState("");
  const [diff, setDiff] = useState<SkillLibraryDiff>();
  const [proposals, setProposals] = useState<SkillLibraryUpdateProposal[]>([]);
  const [libraryName, setLibraryName] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [skillMarkdown, setSkillMarkdown] = useState(DEFAULT_LIBRARY_SKILL);
  const [dryRun, setDryRun] = useState(true);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(() => new Set());

  const selectedLibrary = libraries.find((library) => library.id === selectedId);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[versions.length - 1];
  const selectedLibraryProposals = proposals.filter((proposal) => proposal.libraryId === selectedId && proposal.status === "pending");
  const selectedPendingProposalIds = selectedLibraryProposals
    .map((proposal) => proposal.id)
    .filter((proposalId) => selectedProposalIds.has(proposalId));

  useEffect(() => {
    let active = true;
    void client.listSkillLibraries().then((items) => {
      if (!active) return;
      setLibraries(items);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id);
    }).catch((reason: Error) => {
      if (active) onError(reason.message);
    });
    return () => { active = false; };
  }, [client, onError]);

  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      setSelectedVersionId(undefined);
      setProposals([]);
      setSelectedProposalIds(new Set());
      return;
    }
    let active = true;
    void Promise.all([
      client.listSkillLibraryVersions(selectedId),
      client.listSkillLibraryProposals(selectedId),
    ]).then(([items, nextProposals]) => {
      if (!active) return;
      setVersions(items);
      setProposals(nextProposals);
      setSelectedProposalIds((current) => {
        const pendingIds = new Set(nextProposals.filter((proposal) => proposal.status === "pending").map((proposal) => proposal.id));
        return new Set(Array.from(current).filter((proposalId) => pendingIds.has(proposalId)));
      });
      const head = libraries.find((library) => library.id === selectedId)?.headVersionId;
      setSelectedVersionId((current) => current && items.some((item) => item.id === current) ? current : head ?? items.at(-1)?.id);
      setFromVersionId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
      setToVersionId((current) => current && items.some((item) => item.id === current) ? current : head ?? items.at(-1)?.id ?? "");
    }).catch((reason: Error) => {
      if (active) onError(reason.message);
    });
    return () => { active = false; };
  }, [client, libraries, onError, selectedId]);

  async function refresh(selectId = selectedId): Promise<void> {
    const nextLibraries = await client.listSkillLibraries();
    setLibraries(nextLibraries);
    if (!selectId) {
      setSelectedId(nextLibraries[0]?.id);
      return;
    }
    setSelectedId(selectId);
    const nextVersions = await client.listSkillLibraryVersions(selectId);
    setVersions(nextVersions);
    setProposals(await client.listSkillLibraryProposals(selectId));
    const head = nextLibraries.find((library) => library.id === selectId)?.headVersionId;
    setSelectedVersionId(head ?? nextVersions.at(-1)?.id);
    setFromVersionId(nextVersions[0]?.id ?? "");
    setToVersionId(head ?? nextVersions.at(-1)?.id ?? "");
  }

  async function createLibrary(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus(undefined);
    try {
      const created = await client.createSkillLibrary({
        ...(libraryId.trim() ? { id: libraryId.trim() } : {}),
        ...(libraryName.trim() ? { name: libraryName.trim() } : {}),
      });
      setLibraryId("");
      setLibraryName("");
      setStatus(`Created library ${created.name}.`);
      await refresh(created.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not create skill library";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function commitVersion(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedLibrary) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await client.commitSkillLibraryVersion(selectedLibrary.id, {
        author: { kind: "user", name: "Skill Library UI" },
        baseVersionId: selectedLibrary.headVersionId,
        dryRun,
        operations: [{ package: skillLibraryPackage(skillMarkdown), type: "upsert" }],
      });
      setDiff(result.diff);
      if (result.conflicts.length) {
        setStatus(result.conflicts.map((conflict) => conflict.message).join(" "));
      } else {
        setStatus(dryRun ? `Dry run ready: ${diffCount(result.diff)} change(s).` : `Published version ${result.version?.id.slice(0, 8) ?? ""}.`);
        if (!dryRun) await refresh(selectedLibrary.id);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not commit skill library version";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff(): Promise<void> {
    if (!selectedLibrary || !fromVersionId || !toVersionId) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const next = await client.diffSkillLibraryVersions(selectedLibrary.id, fromVersionId, toVersionId);
      setDiff(next);
      setStatus(`Loaded diff with ${diffCount(next)} change(s).`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load skill library diff";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(): Promise<void> {
    if (!selectedLibrary || !selectedVersion) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await client.rollbackSkillLibrary(selectedLibrary.id, {
        author: { kind: "user", name: "Skill Library UI" },
        baseVersionId: selectedLibrary.headVersionId,
        targetVersionId: selectedVersion.id,
      });
      setDiff(result.diff);
      setStatus(result.conflicts.length ? result.conflicts.map((conflict) => conflict.message).join(" ") : `Rollback version ${result.version?.id.slice(0, 8) ?? ""} published.`);
      if (!result.conflicts.length) await refresh(selectedLibrary.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not rollback skill library";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function publishProposal(proposalId: string): Promise<void> {
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await client.publishSkillLibraryProposal(proposalId);
      setDiff(result.result.diff);
      if (result.result.conflicts.length) {
        setStatus(result.result.conflicts.map((conflict) => conflict.message).join(" "));
      } else {
        setStatus(`Published proposal ${proposalId.slice(0, 8)} as version ${result.result.version?.id.slice(0, 8) ?? ""}.`);
        await refresh(result.proposal.libraryId);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not publish skill library proposal";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function publishSelectedProposals(): Promise<void> {
    if (!selectedPendingProposalIds.length) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await client.publishSkillLibraryProposals(selectedPendingProposalIds);
      setDiff(result.result.diff);
      if (result.result.conflicts.length) {
        setStatus(result.result.conflicts.map((conflict) => conflict.message).join(" "));
      } else {
        setStatus(`Published ${result.proposals.length} proposal(s) as version ${result.result.version?.id.slice(0, 8) ?? ""}.`);
        setSelectedProposalIds(new Set());
        await refresh(result.proposals[0]?.libraryId);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not publish skill library proposals";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  function toggleProposalSelection(proposalId: string, selected: boolean): void {
    setSelectedProposalIds((current) => {
      const next = new Set(current);
      if (selected) next.add(proposalId);
      else next.delete(proposalId);
      return next;
    });
  }

  async function rejectProposal(proposalId: string): Promise<void> {
    setBusy(true);
    setStatus(undefined);
    try {
      const rejected = await client.rejectSkillLibraryProposal(proposalId);
      setStatus(`Rejected proposal ${rejected.id.slice(0, 8)}.`);
      await refresh(rejected.libraryId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not reject skill library proposal";
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="skill-library-manager">
    <section className="skill-manager-hero skill-library-hero">
      <div><span className="eyebrow">Versioned collections</span><h3>Skill libraries</h3></div>
      <div className="skill-manager-hero-actions">
        <SkillManagerViewTabs activeView="libraries" onViewChange={onViewChange} />
        <div aria-label="Skill library summary" className="skill-manager-stats">
          <span><strong>{libraries.length}</strong><small>Libraries</small></span>
          <span><strong>{versions.length}</strong><small>Versions</small></span>
          <span className={selectedLibraryProposals.length ? "has-pending" : undefined}><strong>{selectedLibraryProposals.length}</strong><small>Proposals</small></span>
        </div>
      </div>
    </section>
    <form className="skill-library-create" onSubmit={(event) => void createLibrary(event)}>
      <label><span>Library name</span><input onChange={(event) => setLibraryName(event.target.value)} placeholder="Evaluation skills" value={libraryName} /></label>
      <label><span>Stable id</span><input onChange={(event) => setLibraryId(event.target.value)} placeholder="evaluation-skills" value={libraryId} /></label>
      <button className="primary-button" disabled={busy} type="submit">Create library</button>
    </form>
    {status ? <p className="skill-manager-error" role="status">{status}</p> : null}
    <div className="skill-library-grid">
      <div aria-label="Skill libraries" className="skill-library-catalog">
        <header><strong>Libraries</strong><span>{libraries.length}</span></header>
        {libraries.map((library) => {
          const headVersion = versions.find((version) => version.id === library.headVersionId);
          const isSelected = library.id === selectedId;
          return <button aria-label={`Skill library ${library.name}`} className={isSelected ? "skill-library-card active" : "skill-library-card"} key={library.id} onClick={() => { setSelectedId(library.id); setSelectedProposalIds(new Set()); setDiff(undefined); }} title={library.name} type="button">
          <span aria-hidden="true" className="skill-library-card-icon">L</span>
          <span className="skill-library-card-copy"><strong>{library.name}</strong><small>{library.headVersionId ? `Head ${library.headVersionId.slice(0, 8)}` : "No published versions"}</small>{isSelected && headVersion ? <small>{headVersion.skills.length} skills · {headVersion.contentHash.slice(0, 12)}</small> : null}</span>
          <span className="skill-source managed">{library.id}</span>
        </button>;
        })}
        {!libraries.length ? <p className="skill-empty">Create a skill library to begin.</p> : null}
      </div>
      <div className="skill-library-detail">
        {!selectedLibrary ? <p className="skill-empty">Select or create a library.</p> : <>
          <header><div><span className="skill-source managed">Versioned library</span><h4>{selectedLibrary.name}</h4><p>{selectedLibrary.id} · {versions.length} version(s)</p></div></header>
          <section className="skill-library-section">
            <h5>Versions</h5>
            {versions.length ? <div className="skill-version-list">{versions.map((version) => <button className={version.id === selectedVersionId ? "active" : ""} key={version.id} onClick={() => setSelectedVersionId(version.id)} type="button"><strong>{version.id.slice(0, 8)}</strong><small>{version.skills.length} skills · {version.contentHash.slice(0, 12)}</small></button>)}</div> : <p className="skill-empty">No versions yet.</p>}
          </section>
          <form className="skill-library-section" onSubmit={(event) => void commitVersion(event)}>
            <h5>Commit SKILL.md</h5>
            <textarea aria-label="Skill library package SKILL.md" onChange={(event) => setSkillMarkdown(event.target.value)} rows={9} value={skillMarkdown} />
            <label className="skill-library-checkbox"><input checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} type="checkbox" /><span>Dry run</span></label>
            <button className="primary-button" disabled={busy} type="submit">{dryRun ? "Preview commit" : "Publish version"}</button>
          </form>
          <section className="skill-library-section">
            <h5>Pending proposals</h5>
            {selectedLibraryProposals.length ? <>
              <div className="skill-library-proposal-toolbar">
                <label className="skill-library-checkbox"><input checked={selectedPendingProposalIds.length === selectedLibraryProposals.length} onChange={(event) => setSelectedProposalIds(event.target.checked ? new Set(selectedLibraryProposals.map((proposal) => proposal.id)) : new Set())} type="checkbox" /><span>Select all</span></label>
                <button className="primary-button" disabled={busy || !selectedPendingProposalIds.length} onClick={() => void publishSelectedProposals()} type="button">Publish selected</button>
              </div>
              <div className="skill-version-list">
              {selectedLibraryProposals.map((proposal) => <article className="skill-library-proposal" key={proposal.id}>
                <header><label className="skill-library-checkbox"><input checked={selectedProposalIds.has(proposal.id)} onChange={(event) => toggleProposalSelection(proposal.id, event.target.checked)} type="checkbox" /><strong>{proposal.id.slice(0, 8)}</strong></label><small>{proposal.status} · {diffCount(proposal.result.diff)} change(s)</small></header>
                <p>{proposal.rationale}</p>
                <div className="skill-library-diff" aria-label={`Skill library proposal ${proposal.id} diff`}>
                  {(["added", "modified", "deleted"] as const).map((kind) => <div key={kind}><strong>{kind}</strong>{proposal.result.diff[kind].length ? <ul>{proposal.result.diff[kind].map((entry) => <li key={`${proposal.id}-${kind}-${entry.skillId}`}>{entry.skillId}</li>)}</ul> : <p>None</p>}</div>)}
                </div>
                {proposal.status === "pending" ? <div className="dialog-actions">
                  <button className="secondary-button" disabled={busy} onClick={() => void rejectProposal(proposal.id)} type="button">Reject</button>
                  <button className="primary-button" disabled={busy || Boolean(proposal.result.conflicts.length)} onClick={() => void publishProposal(proposal.id)} type="button">Publish</button>
                </div> : null}
              </article>)}
            </div></> : <p className="skill-empty">No pending proposals.</p>}
          </section>
          <section className="skill-library-section">
            <h5>Diff and rollback</h5>
            <div className="skill-library-diff-controls">
              <select aria-label="Diff from version" onChange={(event) => setFromVersionId(event.target.value)} value={fromVersionId}>{versions.map((version) => <option key={version.id} value={version.id}>{version.id.slice(0, 8)}</option>)}</select>
              <select aria-label="Diff to version" onChange={(event) => setToVersionId(event.target.value)} value={toVersionId}>{versions.map((version) => <option key={version.id} value={version.id}>{version.id.slice(0, 8)}</option>)}</select>
              <button disabled={busy || !fromVersionId || !toVersionId} onClick={() => void loadDiff()} type="button">Load diff</button>
              <button className="danger-button" disabled={busy || !selectedVersion || selectedVersion.id === selectedLibrary.headVersionId} onClick={() => void rollback()} type="button">Rollback to selected</button>
            </div>
            {diff ? <div className="skill-library-diff" aria-label="Skill library diff">
              {(["added", "modified", "deleted"] as const).map((kind) => <div key={kind}><strong>{kind}</strong>{diff[kind].length ? <ul>{diff[kind].map((entry) => <li key={`${kind}-${entry.skillId}`}>{entry.skillId}</li>)}</ul> : <p>None</p>}</div>)}
            </div> : null}
          </section>
        </>}
      </div>
    </div>
  </div>;
}
