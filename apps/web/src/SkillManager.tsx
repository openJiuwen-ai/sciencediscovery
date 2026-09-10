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
import { translate, useLocale, type MessageKey } from "./i18n/index.js";
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

type SkillManagerTranslate = (key: MessageKey, variables?: Record<string, string | number>) => string;

// validateSkillDraft is also exercised directly by unit tests without a React
// tree, so callers may omit t and get the English catalogue.
const translateEnglish: SkillManagerTranslate = (key, variables) => translate("en", key, variables);

function resourceValidationError(resources: SkillEditorResourceDraft[], t: SkillManagerTranslate = translateEnglish): string | undefined {
  const paths = new Set<string>();
  for (const resource of resources) {
    const path = resource.path.trim();
    if (!path) return t("skillManager.error.resourceNeedsPath");
    if (path === "SKILL.md") return t("skillManager.error.skillMdGenerated");
    if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return t("skillManager.error.resourcePathUnsafe", { path });
    }
    if (paths.has(path)) return t("skillManager.error.resourcePathDuplicated", { path });
    paths.add(path);
  }
  return undefined;
}

export function validateSkillDraft(draft: SkillEditorDraft, t: SkillManagerTranslate = translateEnglish): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) || draft.name.length > 64) {
    return t("skillManager.error.nameInvalid");
  }
  const description = draft.description.trim();
  if (!description || description.length > 1024) return t("skillManager.error.descriptionLength");
  if (!draft.instructions.trim()) return t("skillManager.error.instructionsRequired");
  if (draft.compatibility.trim().length > 500) return t("skillManager.error.compatibilityLength");
  return resourceValidationError(draft.resources ?? [], t);
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
  const { t } = useLocale();
  return <div aria-label={t("skillManager.viewsAria")} className="skill-manager-tabs" role="tablist">
    <button aria-selected={activeView === "skills"} className={activeView === "skills" ? "active" : ""} onClick={() => onViewChange("skills")} role="tab" type="button">{t("skillManager.tabSkills")}</button>
    <button aria-selected={activeView === "libraries"} className={activeView === "libraries" ? "active" : ""} onClick={() => onViewChange("libraries")} role="tab" type="button">{t("skillManager.tabLibraries")}</button>
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
  const { t } = useLocale();
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
        if (active) onError(reason instanceof Error ? reason.message : t("skillManager.error.loadDrafts"));
      }
    }
    void refreshPending();
    const interval = globalThis.setInterval(() => void refreshPending(), 3_000);
    return () => { active = false; globalThis.clearInterval(interval); };
  }, [client, onError, t]);

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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.openGeneratedDraft");
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
  }, [client, onError, t, workspaceLaunch?.requestId]);

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
      setGitLinkNotice(t("skillManager.gitLinkNotice", {
        path: normalized.subdirectory ? ` / ${normalized.subdirectory}` : "",
        ref: normalized.ref || t("skillManager.defaultBranch"),
      }));
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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.inspectGit");
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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.prepareGitUpdates");
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSkill(event: FormEvent): Promise<void> {
    event.preventDefault();
    const validation = validateSkillDraft(draft, t);
    if (validation) {
      setLocalError(validation);
      if (resourceValidationError(draft.resources ?? [], t)) setEditorSection("resources");
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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.saveSkill");
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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.importSkill");
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
      const message = reason instanceof Error ? reason.message : t("skillManager.error.importSkillFolder");
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
      if (importFolderInput.current) importFolderInput.current.value = "";
    }
  }

  return <div className="skill-catalog-manager">
    <section className="skill-manager-hero">
      <div><span className="eyebrow">{t("skillManager.eyebrow")}</span><h3>{t("skillManager.title")}</h3></div>
      <div className="skill-manager-hero-actions">
        <SkillManagerViewTabs activeView="skills" onViewChange={onViewChange} />
        <div aria-label={t("skillManager.statsAria")} className="skill-manager-stats">
          <span><strong>{skills.length}</strong><small>{t("skillManager.statInstalled")}</small></span>
          <span><strong>{skills.filter((skill) => skill.source === "managed").length}</strong><small>{t("skillManager.statManaged")}</small></span>
          <span className={reviewDrafts.length ? "has-pending" : undefined}><strong>{reviewDrafts.length}</strong><small>{t("skillManager.statAwaitingReview")}</small></span>
        </div>
      </div>
    </section>
    <div className="skill-manager-toolbar">
      <label className="skill-search-field"><span aria-hidden="true">⌕</span><input aria-label={t("skillManager.searchAria")} onChange={(event) => setQuery(event.target.value)} placeholder={t("skillManager.searchPlaceholder")} type="search" value={query} /></label>
      <button className="skill-explorer-button" disabled={busy} onClick={() => openWorkspace()} type="button">{t("skillManager.openExplorer")}</button>
      <details className="skill-toolbar-menu" name="skill-actions">
        <summary aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>{t("skillManager.createSkillMenu")} <span aria-hidden="true" className="skill-toolbar-chevron"><ChevronDownIcon size={15} /></span></summary>
        <div className="skill-toolbar-popover">
          <span className="skill-toolbar-popover-label">{t("skillManager.createGroupLabel")}</span>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openCreate(); }} type="button"><span className="skill-action-icon">＋</span><span><strong>{t("skillManager.blankSkill")}</strong><small>{t("skillManager.blankSkillHint")}</small></span></button>
          <button disabled={busy || !onStartSkillCreation} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onStartSkillCreation?.(); }} type="button"><span className="skill-action-icon">✦</span><span><strong>{t("skillManager.describeWorkflow")}</strong><small>{t("skillManager.describeWorkflowHint")}</small></span></button>
          <button disabled={busy || !sessionId || !onDistillSession} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDistillSession?.(); }} title={sessionId ? t("skillManager.distillTitleActive") : t("skillManager.distillTitleNoSession")} type="button"><span className="skill-action-icon">◇</span><span><strong>{t("skillManager.distillSession")}</strong><small>{t("skillManager.distillSessionHint")}</small></span></button>
        </div>
      </details>
      <details className="skill-toolbar-menu skill-import-menu" name="skill-actions">
        <summary aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>{t("skillManager.importMenu")} <span aria-hidden="true" className="skill-toolbar-chevron"><ChevronDownIcon size={15} /></span></summary>
        <div className="skill-toolbar-popover">
          <span className="skill-toolbar-popover-label">{t("skillManager.importGroupLabel")}</span>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importInput.current?.click(); }} type="button"><span className="skill-action-icon">↥</span><span><strong>{t("skillManager.importFile")}</strong><small>{t("skillManager.importFileHint")}</small></span></button>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); importFolderInput.current?.click(); }} type="button"><span className="skill-action-icon">□</span><span><strong>{t("skillManager.importFolder")}</strong><small>{t("skillManager.importFolderHint")}</small></span></button>
          <button disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setAuthoringMode("git"); setGitImport({ ref: "", repositoryUrl: "", subdirectory: "" }); setGitInspection(undefined); setGitLinkNotice(undefined); }} type="button"><span className="skill-action-icon">⑂</span><span><strong>{t("skillManager.importGit")}</strong><small>{t("skillManager.importGitHint")}</small></span></button>
        </div>
      </details>
      <input accept=".md,.zip,text/markdown,application/zip" aria-label={t("skillManager.importFileAria")} className="visually-hidden" onChange={(event) => void importSkill(event.target.files?.[0])} ref={importInput} type="file" />
      <input {...{ webkitdirectory: "" }} aria-label={t("skillManager.importFolderAria")} className="visually-hidden" multiple onChange={(event) => void importSkillFolder(event.target.files)} ref={importFolderInput} type="file" />
    </div>
    {reviewDrafts.length ? <section className="skill-review-queue"><span aria-hidden="true" className="skill-review-queue-icon">!</span><div><strong>{t(reviewDrafts.length === 1 ? "skillManager.pendingReviewOne" : "skillManager.pendingReviewMany", { count: reviewDrafts.length })}</strong><p>{t("skillManager.reviewQueueHint")}</p></div><button disabled={busy} onClick={() => openWorkspace(reviewDrafts[0]?.name)} type="button">{t("skillManager.openReviewWorkspace")} <span>{reviewDrafts.length}</span></button></section> : null}
    {authoringMode === "git" ? <form className="skill-authoring-panel skill-git-import-panel" onSubmit={(event) => void inspectGitRepository(event)}>
      <div className="skill-authoring-heading"><div><span className="eyebrow">{t("skillManager.gitEyebrow")}</span><h4>{t("skillManager.gitHeading")}</h4></div>{gitInspection ? <span className="skill-git-commit" title={gitInspection.commit}>{t("skillManager.gitCommitBadge", { hash: gitInspection.commit.slice(0, 12) })}</span> : null}</div>
      <label><span>{t("skillManager.gitUrlLabel")}</span><input autoFocus onBlur={adaptGitLocation} onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, repositoryUrl: event.target.value })); }} placeholder="https://github.com/org/repo/tree/main/skills" required value={gitImport.repositoryUrl} /></label>
      {gitLinkNotice ? <div className="skill-git-link-notice"><span aria-hidden="true">✓</span><div><strong>{t("skillManager.gitLinkAdapted")}</strong><small>{gitLinkNotice}</small></div></div> : null}
      <div className="skill-editor-columns"><label><span>{t("skillManager.gitRefLabel")}</span><input onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, ref: event.target.value })); }} placeholder={t("skillManager.gitRefPlaceholder")} value={gitImport.ref} /></label><label><span>{t("skillManager.gitPathLabel")}</span><input onChange={(event) => { setGitInspection(undefined); setGitLinkNotice(undefined); setGitImport((current) => ({ ...current, subdirectory: event.target.value })); }} placeholder="skills/my-skill" value={gitImport.subdirectory} /></label></div>
      <p>{t("skillManager.gitHelpBefore")}<code>/tree/ref/path</code>{t("skillManager.gitHelpAfter")}</p>
      {gitInspection ? <fieldset className="skill-git-candidates"><legend>{t("skillManager.gitSelectLegend")}</legend>{gitInspection.candidates.map((candidate) => {
        const selectable = candidate.status === "new" || candidate.status === "update";
        const selected = gitSelected.includes(candidate.subdirectory);
        return <label className={`skill-git-candidate ${candidate.status}`} key={candidate.subdirectory}>
          <input checked={selected} disabled={!selectable || busy} onChange={(event) => setGitSelected((current) => event.target.checked ? [...current, candidate.subdirectory] : current.filter((path) => path !== candidate.subdirectory))} type="checkbox" />
          <span className="skill-git-candidate-copy"><strong>{candidate.name ?? candidate.subdirectory}</strong><small>{candidate.subdirectory}{candidate.description ? ` · ${candidate.description}` : ""}</small>{candidate.diagnostics.length ? <em>{candidate.diagnostics.join(" · ")}</em> : null}</span>
          <span className={`skill-git-status ${candidate.status}`}>{candidate.status === "update" ? t("skillManager.gitUpdateBadge", { revision: candidate.currentRevision ?? "" }) : candidate.status}</span>
        </label>;
      })}</fieldset> : null}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => { setAuthoringMode(undefined); setGitInspection(undefined); }} type="button">{t("common.cancel")}</button>{gitInspection ? <><button className="secondary-button" disabled={busy} type="submit">{t("skillManager.scanAgain")}</button><button className="primary-button" disabled={busy || !gitSelected.length} onClick={() => void createGitReviewDrafts()} type="button">{t(gitSelected.length === 1 ? "skillManager.reviewSelectedOne" : "skillManager.reviewSelectedMany", { count: gitSelected.length })}</button></> : <button className="primary-button" disabled={busy} type="submit">{t("skillManager.scanRepository")}</button>}</div>
    </form> : null}
    {localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}
    <section aria-label={t("skillManager.catalogAria")} className="skill-library-panel">
      <header className="skill-library-heading"><div><strong>{t("skillManager.libraryTitle")}</strong><small>{query ? t("skillManager.resultsCount", { count: visibleSkills.length }) : t("skillManager.availableCount", { count: skills.length })}</small></div><span>{t("skillManager.selectHint")}</span></header>
      <div className="skill-library-list">
        {visibleSkills.map((skill) => <button aria-label={t("skillManager.openInExplorer", { name: skill.name })} className="skill-card" key={skill.id} onClick={() => openWorkspace(skill.id)} title={t("skillManager.openInExplorer", { name: skill.name })} type="button">
          <span aria-hidden="true" className={`skill-card-icon ${skill.source}`}>{skill.source === "built-in" ? "B" : "S"}</span>
          <span className="skill-card-copy"><strong>{skill.name}</strong><small>{skill.description}</small><span className="skill-card-metadata"><span>v{skill.version}</span><span>{t(skill.resourceSummary.files === 1 ? "skillManager.supportingFileOne" : "skillManager.supportingFiles", { count: skill.resourceSummary.files })}</span></span></span>
          <span className={`skill-source ${skill.source}`}>{skill.source === "built-in" ? t("skillManager.builtInReadOnly") : t("skillManager.managedRevision", { revision: skill.currentRevision })}</span>
          <span aria-hidden="true" className="skill-card-open"><span>{t("skillManager.openAction")}</span><ChevronRightIcon size={17} /></span>
        </button>)}
        {!visibleSkills.length ? <div className="skill-library-empty"><span aria-hidden="true">⌕</span><strong>{t("skillManager.noMatches")}</strong><p>{t("skillManager.noMatchesHint")}</p></div> : null}
      </div>
    </section>

    {editorMode ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditorMode(undefined); }}>
      <section aria-label={t("skillManager.createTitle")} aria-modal="true" className="skill-editor-dialog" role="dialog">
        <header className="skill-editor-header"><div><span className="eyebrow">{t("skillManager.createEyebrow")}</span><h2>{t("skillManager.createTitle")}</h2><p>{t("skillManager.createIntro")}</p></div><button aria-label={t("skillManager.createCloseAria")} className="icon-button" disabled={busy} onClick={() => setEditorMode(undefined)} type="button"><CloseIcon size={18} /></button></header>
        <form onSubmit={(event) => void saveSkill(event)}>
          <nav aria-label={t("skillManager.createSectionsAria")} className="skill-editor-tabs"><button className={editorSection === "details" ? "active" : ""} onClick={() => setEditorSection("details")} type="button"><strong>{t("skillManager.tabDetails")}</strong><small>SKILL.md</small></button><button className={editorSection === "resources" ? "active" : ""} onClick={() => setEditorSection("resources")} type="button"><strong>{t("skillManager.tabResources")}</strong><small>{draft.resources?.length ?? 0}</small></button></nav>
          <div className="skill-editor-body">
            {draftSourceSummary ? <p className="skill-preservation-note">{t("skillManager.draftInactiveNote", { summary: draftSourceSummary })}</p> : null}
            {editorSection === "details" ? <div className="skill-editor-details">
              <label><span>{t("skillManager.fieldName")}</span><input autoFocus disabled={busy} maxLength={64} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="literature-review" required value={draft.name} /></label>
              <label><span>{t("skillManager.fieldDescription")}</span><textarea maxLength={1024} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} required rows={3} value={draft.description} /></label>
              <div className="skill-editor-columns"><label><span>{t("skillManager.fieldLicense")}</span><input onChange={(event) => setDraft((current) => ({ ...current, license: event.target.value }))} value={draft.license} /></label><label><span>{t("skillManager.fieldVersion")}</span><input onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} placeholder="1.0.0" value={draft.version} /></label></div>
              <label><span>{t("skillManager.fieldCompatibility")}</span><input maxLength={500} onChange={(event) => setDraft((current) => ({ ...current, compatibility: event.target.value }))} value={draft.compatibility} /></label>
              <label><span>{t("skillManager.fieldAllowedTools")}</span><input onChange={(event) => setDraft((current) => ({ ...current, allowedTools: event.target.value }))} value={draft.allowedTools} /></label>
              <label><span>{t("skillManager.fieldInstructions")}</span><textarea className="skill-markdown-editor" onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} required rows={12} value={draft.instructions} /></label>
            </div> : <div className="skill-resource-authoring">
              <header><div><strong>{t("skillManager.resourcesTitle")}</strong><p>{t("skillManager.resourcesIntro")}</p></div><div><button onClick={() => addResource("reference")} type="button"><PlusIcon size={14} />{` ${t("skillManager.addReference")}`}</button><button onClick={() => addResource("script")} type="button"><PlusIcon size={14} />{` ${t("skillManager.addScript")}`}</button><button onClick={() => addResource("other")} type="button"><PlusIcon size={14} />{` ${t("skillManager.addOtherFile")}`}</button></div></header>
              {(draft.resources?.length ?? 0) ? <div className="skill-resource-authoring-list">{draft.resources!.map((resource, index) => {
                const kind = resource.path.startsWith("references/") ? t("skillManager.resourceKind.reference") : resource.path.startsWith("scripts/") ? t("skillManager.resourceKind.script") : resource.path.startsWith("assets/") ? t("skillManager.resourceKind.asset") : t("skillManager.resourceKind.other");
                return <article key={resource.id}><header><span aria-hidden="true"><FileIcon size={16} /></span><label><span>{kind} {index + 1}</span><input aria-label={t("skillManager.resourcePathAria", { index: index + 1 })} onChange={(event) => updateResource(resource.id, { path: event.target.value })} placeholder="references/guide.md" spellCheck={false} value={resource.path} /></label><button aria-label={t("skillManager.resourceRemoveAria", { path: resource.path || index + 1 })} onClick={() => removeResource(resource.id)} title={t("skillManager.resourceRemoveTitle")} type="button"><TrashIcon size={16} /></button></header><label><span>{t("skillManager.resourceContentLabel")}</span><textarea aria-label={t("skillManager.resourceContentAria", { index: index + 1 })} className="skill-resource-content-editor" onChange={(event) => updateResource(resource.id, { content: event.target.value })} rows={9} spellCheck={false} value={resource.content} /></label></article>;
              })}</div> : <div className="skill-resource-authoring-empty"><span aria-hidden="true"><FileIcon size={24} /></span><strong>{t("skillManager.resourcesEmptyTitle")}</strong><p>{t("skillManager.resourcesEmptyHint")}</p><button onClick={() => addResource("reference")} type="button"><PlusIcon size={15} />{` ${t("skillManager.resourcesEmptyCta")}`}</button></div>}
            </div>}
          </div>
          <div className="skill-editor-error-slot">{localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}</div>
          <footer><span>{t((draft.resources?.length ?? 0) === 1 ? "skillManager.resourcesPackagedOne" : "skillManager.resourcesPackagedMany", { count: draft.resources?.length ?? 0 })}</span><div><button className="secondary-button" disabled={busy} onClick={() => setEditorMode(undefined)} type="button">{t("common.cancel")}</button><button className="primary-button" disabled={busy} type="submit">{busy ? t("common.saving") : t("skillManager.createTitle")}</button></div></footer>
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
  const { t } = useLocale();
  const [selectedId, setSelectedId] = useState<string>();
  const [versions, setVersions] = useState<SkillLibraryVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [fromVersionId, setFromVersionId] = useState("");
  const [toVersionId, setToVersionId] = useState("");
  const [diff, setDiff] = useState<SkillLibraryDiff>();
  const [proposals, setProposals] = useState<SkillLibraryUpdateProposal[]>([]);
  const [libraryName, setLibraryName] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
      setCreateOpen(false);
      setStatus(t("skillLibrary.createdStatus", { name: created.name }));
      await refresh(created.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.create");
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
        setStatus(dryRun ? t("skillLibrary.dryRunReady", { count: diffCount(result.diff) }) : t("skillLibrary.publishedVersion", { id: result.version?.id.slice(0, 8) ?? "" }));
        if (!dryRun) await refresh(selectedLibrary.id);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.commit");
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
      setStatus(t("skillLibrary.diffLoaded", { count: diffCount(next) }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.loadDiff");
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(): Promise<void> {
    if (!selectedLibrary || !selectedVersion) return;
    if (!window.confirm(t("skillLibrary.rollbackConfirm", { id: selectedVersion.id.slice(0, 8), name: selectedLibrary.name }))) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await client.rollbackSkillLibrary(selectedLibrary.id, {
        author: { kind: "user", name: "Skill Library UI" },
        baseVersionId: selectedLibrary.headVersionId,
        targetVersionId: selectedVersion.id,
      });
      setDiff(result.diff);
      setStatus(result.conflicts.length ? result.conflicts.map((conflict) => conflict.message).join(" ") : t("skillLibrary.rollbackPublished", { id: result.version?.id.slice(0, 8) ?? "" }));
      if (!result.conflicts.length) await refresh(selectedLibrary.id);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.rollback");
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
        setStatus(t("skillLibrary.proposalPublished", { proposal: proposalId.slice(0, 8), version: result.result.version?.id.slice(0, 8) ?? "" }));
        await refresh(result.proposal.libraryId);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.publishProposal");
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
        setStatus(t("skillLibrary.proposalsPublished", { count: result.proposals.length, version: result.result.version?.id.slice(0, 8) ?? "" }));
        setSelectedProposalIds(new Set());
        await refresh(result.proposals[0]?.libraryId);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.publishProposals");
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
      setStatus(t("skillLibrary.proposalRejected", { id: rejected.id.slice(0, 8) }));
      await refresh(rejected.libraryId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("skillLibrary.error.rejectProposal");
      setStatus(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="skill-library-manager">
    <section className="skill-manager-hero skill-library-hero">
      <div><span className="eyebrow">{t("skillLibrary.eyebrow")}</span><h3>{t("skillLibrary.title")}</h3></div>
      <div className="skill-manager-hero-actions">
        <SkillManagerViewTabs activeView="libraries" onViewChange={onViewChange} />
        <div aria-label={t("skillLibrary.statsAria")} className="skill-manager-stats">
          <span><strong>{libraries.length}</strong><small>{t("skillLibrary.statLibraries")}</small></span>
          <span><strong>{versions.length}</strong><small>{t("skillLibrary.statVersions")}</small></span>
          <span className={selectedLibraryProposals.length ? "has-pending" : undefined}><strong>{selectedLibraryProposals.length}</strong><small>{t("skillLibrary.statProposals")}</small></span>
        </div>
      </div>
    </section>
    {!createOpen ? <button className="secondary-button skill-library-create-toggle" disabled={busy} onClick={() => setCreateOpen(true)} type="button">{t("skillLibrary.newLibrary")}</button> : null}
    {createOpen ? <form className="skill-library-create" onSubmit={(event) => void createLibrary(event)}>
      <label><span>{t("skillLibrary.nameLabel")}</span><input onChange={(event) => setLibraryName(event.target.value)} placeholder={t("skillLibrary.namePlaceholder")} value={libraryName} /></label>
      <label><span>{t("skillLibrary.idLabel")}</span><input onChange={(event) => setLibraryId(event.target.value)} placeholder="evaluation-skills" value={libraryId} /></label>
      <div className="skill-library-create-actions"><button className="secondary-button" disabled={busy} onClick={() => { setLibraryId(""); setLibraryName(""); setCreateOpen(false); }} type="button">{t("common.cancel")}</button><button className="primary-button" disabled={busy} type="submit">{t("skillLibrary.createLibrary")}</button></div>
    </form> : null}
    {status ? <p className="skill-manager-error" role="status">{status}</p> : null}
    <div className="skill-library-grid">
      <div aria-label={t("skillLibrary.title")} className="skill-library-catalog">
        <header><strong>{t("skillLibrary.statLibraries")}</strong><span>{libraries.length}</span></header>
        {libraries.map((library) => {
          const headVersion = versions.find((version) => version.id === library.headVersionId);
          const isSelected = library.id === selectedId;
          return <button aria-label={t("skillLibrary.cardAria", { name: library.name })} className={isSelected ? "skill-library-card active" : "skill-library-card"} key={library.id} onClick={() => { setSelectedId(library.id); setSelectedProposalIds(new Set()); setDiff(undefined); }} title={library.name} type="button">
          <span aria-hidden="true" className="skill-library-card-icon">L</span>
          <span className="skill-library-card-copy"><strong>{library.name}</strong><small>{library.headVersionId ? t("skillLibrary.head", { id: library.headVersionId.slice(0, 8) }) : t("skillLibrary.noPublishedVersions")}</small>{isSelected && headVersion ? <small>{t("skillLibrary.skillsAndHash", { count: headVersion.skills.length, hash: headVersion.contentHash.slice(0, 12) })}</small> : null}</span>
          <span className="skill-source managed">{library.id}</span>
        </button>;
        })}
        {!libraries.length ? <p className="skill-empty">{t("skillLibrary.emptyLibraries")}</p> : null}
      </div>
      <div className="skill-library-detail">
        {!selectedLibrary ? <p className="skill-empty">{t("skillLibrary.selectLibrary")}</p> : <>
          <header><div><span className="skill-source managed">{t("skillLibrary.versionedLibrary")}</span><h4>{selectedLibrary.name}</h4><p>{t("skillLibrary.versionCount", { count: versions.length, id: selectedLibrary.id })}</p></div></header>
          <section className="skill-library-section">
            <h5>{t("skillLibrary.statVersions")}</h5>
            {versions.length ? <div className="skill-version-list">{versions.map((version) => <button className={version.id === selectedVersionId ? "active" : ""} key={version.id} onClick={() => setSelectedVersionId(version.id)} type="button"><strong>{version.id.slice(0, 8)}</strong><small>{t("skillLibrary.skillsAndHash", { count: version.skills.length, hash: version.contentHash.slice(0, 12) })}</small></button>)}</div> : <p className="skill-empty">{t("skillLibrary.noVersions")}</p>}
          </section>
          <form className="skill-library-section" onSubmit={(event) => void commitVersion(event)}>
            <h5>{t("skillLibrary.commitHeading")}</h5>
            <textarea aria-label={t("skillLibrary.commitAria")} onChange={(event) => setSkillMarkdown(event.target.value)} rows={9} value={skillMarkdown} />
            <label className="skill-library-checkbox"><input checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} type="checkbox" /><span>{t("skillLibrary.dryRun")}</span></label>
            <button className="primary-button" disabled={busy} type="submit">{dryRun ? t("skillLibrary.previewCommit") : t("skillLibrary.publishVersion")}</button>
          </form>
          <section className="skill-library-section">
            <h5>{t("skillLibrary.pendingProposals")}</h5>
            {selectedLibraryProposals.length ? <>
              <div className="skill-library-proposal-toolbar">
                <label className="skill-library-checkbox"><input checked={selectedPendingProposalIds.length === selectedLibraryProposals.length} onChange={(event) => setSelectedProposalIds(event.target.checked ? new Set(selectedLibraryProposals.map((proposal) => proposal.id)) : new Set())} type="checkbox" /><span>{t("skillLibrary.selectAll")}</span></label>
                <button className="primary-button" disabled={busy || !selectedPendingProposalIds.length} onClick={() => void publishSelectedProposals()} type="button">{t("skillLibrary.publishSelected")}</button>
              </div>
              <div className="skill-version-list">
              {selectedLibraryProposals.map((proposal) => <article className="skill-library-proposal" key={proposal.id}>
                <header><label className="skill-library-checkbox"><input checked={selectedProposalIds.has(proposal.id)} onChange={(event) => toggleProposalSelection(proposal.id, event.target.checked)} type="checkbox" /><strong>{proposal.id.slice(0, 8)}</strong></label><small>{t("skillLibrary.proposalStatusChanges", { count: diffCount(proposal.result.diff), status: proposal.status })}</small></header>
                <p>{proposal.rationale}</p>
                <div className="skill-library-diff" aria-label={t("skillLibrary.proposalDiffAria", { id: proposal.id })}>
                  {(["added", "modified", "deleted"] as const).map((kind) => <div key={kind}><strong>{kind}</strong>{proposal.result.diff[kind].length ? <ul>{proposal.result.diff[kind].map((entry) => <li key={`${proposal.id}-${kind}-${entry.skillId}`}>{entry.skillId}</li>)}</ul> : <p>{t("skillLibrary.none")}</p>}</div>)}
                </div>
                {proposal.status === "pending" ? <div className="dialog-actions">
                  <button className="secondary-button" disabled={busy} onClick={() => void rejectProposal(proposal.id)} type="button">{t("skillLibrary.reject")}</button>
                  <button className="primary-button" disabled={busy || Boolean(proposal.result.conflicts.length)} onClick={() => void publishProposal(proposal.id)} type="button">{t("skillLibrary.publish")}</button>
                </div> : null}
              </article>)}
            </div></> : <p className="skill-empty">{t("skillLibrary.noPendingProposals")}</p>}
          </section>
          <section className="skill-library-section">
            <h5>{t("skillLibrary.diffRollbackHeading")}</h5>
            <div className="skill-library-diff-controls">
              <select aria-label={t("skillLibrary.diffFromAria")} onChange={(event) => setFromVersionId(event.target.value)} value={fromVersionId}>{versions.map((version) => <option key={version.id} value={version.id}>{version.id.slice(0, 8)}</option>)}</select>
              <select aria-label={t("skillLibrary.diffToAria")} onChange={(event) => setToVersionId(event.target.value)} value={toVersionId}>{versions.map((version) => <option key={version.id} value={version.id}>{version.id.slice(0, 8)}</option>)}</select>
              <button disabled={busy || !fromVersionId || !toVersionId} onClick={() => void loadDiff()} type="button">{t("skillLibrary.loadDiff")}</button>
              <button className="danger-button" disabled={busy || !selectedVersion || selectedVersion.id === selectedLibrary.headVersionId} onClick={() => void rollback()} type="button">{t("skillLibrary.rollbackToSelected")}</button>
            </div>
            {diff ? <div className="skill-library-diff" aria-label={t("skillLibrary.diffAria")}>
              {(["added", "modified", "deleted"] as const).map((kind) => <div key={kind}><strong>{kind}</strong>{diff[kind].length ? <ul>{diff[kind].map((entry) => <li key={`${kind}-${entry.skillId}`}>{entry.skillId}</li>)}</ul> : <p>{t("skillLibrary.none")}</p>}</div>)}
            </div> : null}
          </section>
        </>}
      </div>
    </div>
  </div>;
}
