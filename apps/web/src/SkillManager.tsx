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

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  CreateSkillRequest,
  SkillLibrary,
  SkillLibraryDiff,
  SkillLibraryVersion,
  SkillDeletionImpact,
  SkillDescriptor,
  SkillDetail,
  SkillDraft as GeneratedSkillDraft,
} from "@science-agent/schema";

import type { ApiClient } from "./api.js";
import { CloseIcon } from "./icons.js";

interface SkillEditorDraft {
  allowedTools: string;
  compatibility: string;
  description: string;
  instructions: string;
  license: string;
  metadata: Record<string, string>;
  name: string;
  version: string;
}

const EMPTY_DRAFT: SkillEditorDraft = {
  allowedTools: "",
  compatibility: "",
  description: "",
  instructions: "# Instructions\n\n",
  license: "",
  metadata: {},
  name: "",
  version: "",
};

export function validateSkillDraft(draft: SkillEditorDraft): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) || draft.name.length > 64) {
    return "Name must use 1–64 lowercase letters, digits, or single hyphens.";
  }
  const description = draft.description.trim();
  if (!description || description.length > 1024) return "Description must contain 1–1024 characters.";
  if (!draft.instructions.trim()) return "Markdown instructions are required.";
  if (draft.compatibility.trim().length > 500) return "Compatibility must be at most 500 characters.";
  return undefined;
}

function draftFromDetail(detail: SkillDetail): SkillEditorDraft {
  const metadata = detail.frontmatter.metadata && typeof detail.frontmatter.metadata === "object" && !Array.isArray(detail.frontmatter.metadata)
    ? Object.fromEntries(Object.entries(detail.frontmatter.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return {
    allowedTools: typeof detail.frontmatter["allowed-tools"] === "string" ? detail.frontmatter["allowed-tools"] : "",
    compatibility: typeof detail.frontmatter.compatibility === "string" ? detail.frontmatter.compatibility : "",
    description: detail.description,
    instructions: detail.instructions,
    license: typeof detail.frontmatter.license === "string" ? detail.frontmatter.license : "",
    metadata,
    name: detail.name,
    version: metadata.version ?? "",
  };
}

function requestFromDraft(draft: SkillEditorDraft): CreateSkillRequest {
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
  };
}

function editorDraftFromGenerated(draft: GeneratedSkillDraft): SkillEditorDraft {
  return {
    allowedTools: draft.allowedTools ?? "",
    compatibility: draft.compatibility ?? "",
    description: draft.description,
    instructions: draft.instructions,
    license: draft.license ?? "",
    metadata: draft.metadata ?? {},
    name: draft.name,
    version: draft.metadata?.version ?? "",
  };
}

export function SkillManager({
  client,
  initialView = "skills",
  onCatalogChange,
  onError,
  sessionId,
  skills,
}: {
  client: ApiClient;
  initialView?: "libraries" | "skills";
  onCatalogChange: (skills: SkillDescriptor[]) => void;
  onError: (message: string) => void;
  sessionId?: string;
  skills: SkillDescriptor[];
}) {
  const [view, setView] = useState<"libraries" | "skills">(initialView);

  if (view === "libraries") {
    return <div className="skill-manager">
      <SkillManagerHeader activeView={view} onViewChange={setView} />
      <SkillLibraryManager client={client} onError={onError} />
    </div>;
  }

  return <div className="skill-manager">
    <SkillManagerHeader activeView={view} onViewChange={setView} />
    <SkillCatalogManager
      client={client}
      onCatalogChange={onCatalogChange}
      onError={onError}
      sessionId={sessionId}
      skills={skills}
    />
  </div>;
}

function SkillManagerHeader({
  activeView,
  onViewChange,
}: {
  activeView: "libraries" | "skills";
  onViewChange: (view: "libraries" | "skills") => void;
}) {
  return <>
    <div className="settings-detail-header"><span className="eyebrow">Agent Skills</span><h3>Skill manager</h3><p>Author portable skills and manage versioned skill libraries for batch evaluation writeback.</p></div>
    <div aria-label="Skill manager views" className="skill-manager-tabs" role="tablist">
      <button aria-selected={activeView === "skills"} className={activeView === "skills" ? "active" : ""} onClick={() => onViewChange("skills")} role="tab" type="button">Skills</button>
      <button aria-selected={activeView === "libraries"} className={activeView === "libraries" ? "active" : ""} onClick={() => onViewChange("libraries")} role="tab" type="button">Libraries</button>
    </div>
  </>;
}

function SkillCatalogManager({
  client,
  onCatalogChange,
  onError,
  sessionId,
  skills,
}: {
  client: ApiClient;
  onCatalogChange: (skills: SkillDescriptor[]) => void;
  onError: (message: string) => void;
  sessionId?: string;
  skills: SkillDescriptor[];
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(skills[0]?.id);
  const [detail, setDetail] = useState<SkillDetail>();
  const [query, setQuery] = useState("");
  const [editorMode, setEditorMode] = useState<"create" | "edit">();
  const [draft, setDraft] = useState<SkillEditorDraft>(EMPTY_DRAFT);
  const [authoringMode, setAuthoringMode] = useState<"dialogue" | "git">();
  const [dialogueDescription, setDialogueDescription] = useState("");
  const [gitImport, setGitImport] = useState({ ref: "", repositoryUrl: "", subdirectory: "" });
  const [draftSourceSummary, setDraftSourceSummary] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [deleteImpact, setDeleteImpact] = useState<SkillDeletionImpact>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [resourcePreview, setResourcePreview] = useState<{ content: string; path: string }>();
  const importInput = useRef<HTMLInputElement>(null);

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(normalized))
      : skills;
  }, [query, skills]);

  useEffect(() => {
    if (selectedId && skills.some((skill) => skill.id === selectedId)) return;
    setSelectedId(skills[0]?.id);
  }, [selectedId, skills]);

  useEffect(() => {
    setDetail(undefined);
    setResourcePreview(undefined);
    if (!selectedId) return;
    let active = true;
    void client.getSkill(selectedId).then((value) => {
      if (active) setDetail(value);
    }).catch((reason: Error) => {
      if (active) onError(reason.message);
    });
    return () => { active = false; };
  }, [client, onError, selectedId]);

  async function refreshCatalog(selectId?: string): Promise<void> {
    const next = await client.listSkills();
    onCatalogChange(next);
    if (selectId) setSelectedId(selectId);
  }

  function openCreate(): void {
    setDraft(EMPTY_DRAFT);
    setLocalError(undefined);
    setEditorMode("create");
    setDraftSourceSummary(undefined);
  }

  async function createDialogueDraft(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setLocalError(undefined);
    try {
      const generated = await client.createSkillDialogueDraft({ description: dialogueDescription });
      setDraft(editorDraftFromGenerated(generated));
      setDraftSourceSummary(generated.sourceSummary);
      setEditorMode("create");
      setAuthoringMode(undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not draft skill";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function distillSession(): Promise<void> {
    if (!sessionId) return;
    setBusy(true);
    setLocalError(undefined);
    try {
      const generated = await client.distillSessionSkill(sessionId);
      setDraft(editorDraftFromGenerated(generated));
      setDraftSourceSummary(generated.sourceSummary);
      setEditorMode("create");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not distill Session";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function importFromGit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setLocalError(undefined);
    try {
      const imported = await client.importSkillFromGit({
        ...(gitImport.ref.trim() ? { ref: gitImport.ref.trim() } : {}),
        repositoryUrl: gitImport.repositoryUrl.trim(),
        ...(gitImport.subdirectory.trim() ? { subdirectory: gitImport.subdirectory.trim() } : {}),
      });
      await refreshCatalog(imported.id);
      setDetail(imported);
      setAuthoringMode(undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not import Git skill";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(): void {
    if (!detail || detail.readOnly) return;
    setDraft(draftFromDetail(detail));
    setDraftSourceSummary(undefined);
    setLocalError(undefined);
    setEditorMode("edit");
  }

  async function saveSkill(event: FormEvent): Promise<void> {
    event.preventDefault();
    const validation = validateSkillDraft(draft);
    if (validation) {
      setLocalError(validation);
      return;
    }
    setBusy(true);
    setLocalError(undefined);
    try {
      const request = requestFromDraft(draft);
      const saved = editorMode === "edit" && detail
        ? await client.updateSkill(detail.id, { ...request, expectedRevision: detail.currentRevision })
        : await client.createSkill(request);
      await refreshCatalog(saved.id);
      setDetail(saved);
      setEditorMode(undefined);
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
      await refreshCatalog(imported.id);
      setDetail(imported);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not import skill";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function inspectDeletion(): Promise<void> {
    if (!detail || detail.readOnly) return;
    setBusy(true);
    try {
      setDeleteImpact(await client.getSkillDeletionImpact(detail.id));
      setDeleteConfirmation("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not inspect skill references");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeletion(): Promise<void> {
    if (!detail || deleteConfirmation !== detail.id || deleteImpact?.references.length) return;
    setBusy(true);
    try {
      await client.deleteSkill(detail.id);
      setDeleteImpact(undefined);
      setDetail(undefined);
      await refreshCatalog();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not delete skill");
    } finally {
      setBusy(false);
    }
  }

  async function previewResource(path: string): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      const resource = await client.readSkillResource(detail.id, path);
      setResourcePreview({ content: resource.content, path: resource.path });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not preview skill resource");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="skill-manager-toolbar">
      <input aria-label="Search skills" onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" type="search" value={query} />
      <button disabled={busy} onClick={openCreate} type="button">+ New</button>
      <button disabled={busy} onClick={() => setAuthoringMode("dialogue")} type="button">Describe workflow</button>
      <button disabled={busy || !sessionId} onClick={() => void distillSession()} title={sessionId ? "Create a reviewable draft from the active Session" : "Open a Session first"} type="button">Distill Session</button>
      <button disabled={busy} onClick={() => importInput.current?.click()} type="button">{busy ? "Working…" : "Import"}</button>
      <button disabled={busy} onClick={() => setAuthoringMode("git")} type="button">Import Git</button>
      <input accept=".md,.zip,text/markdown,application/zip" aria-label="Import SKILL.md or ZIP" className="visually-hidden" onChange={(event) => void importSkill(event.target.files?.[0])} ref={importInput} type="file" />
    </div>
    {authoringMode === "dialogue" ? <form className="skill-authoring-panel" onSubmit={(event) => void createDialogueDraft(event)}>
      <label><span>Describe the reusable workflow</span><textarea autoFocus maxLength={4000} onChange={(event) => setDialogueDescription(event.target.value)} placeholder="Explain when to use the workflow, its inputs, steps, outputs, and checks…" required rows={4} value={dialogueDescription} /></label>
      <p>The generated package remains a draft until you review and save it.</p>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setAuthoringMode(undefined)} type="button">Cancel</button><button className="primary-button" disabled={busy} type="submit">Create reviewable draft</button></div>
    </form> : null}
    {authoringMode === "git" ? <form className="skill-authoring-panel" onSubmit={(event) => void importFromGit(event)}>
      <label><span>Authorized repository URL</span><input autoFocus onChange={(event) => setGitImport((current) => ({ ...current, repositoryUrl: event.target.value }))} placeholder="https://host/org/repository.git" required value={gitImport.repositoryUrl} /></label>
      <div className="skill-editor-columns"><label><span>Ref (optional)</span><input onChange={(event) => setGitImport((current) => ({ ...current, ref: event.target.value }))} placeholder="main or v1.0.0" value={gitImport.ref} /></label><label><span>Skill subdirectory (optional)</span><input onChange={(event) => setGitImport((current) => ({ ...current, subdirectory: event.target.value }))} placeholder="skills/my-skill" value={gitImport.subdirectory} /></label></div>
      <p>Credentials are read from the local Git credential helper or SSH configuration and are never put into agent context.</p>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setAuthoringMode(undefined)} type="button">Cancel</button><button className="primary-button" disabled={busy} type="submit">Validate and import</button></div>
    </form> : null}
    {localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}
    <div className="skill-manager-grid">
      <div aria-label="Skill catalog" className="skill-catalog-list">
        {visibleSkills.map((skill) => <button className={skill.id === selectedId ? "skill-card active" : "skill-card"} key={skill.id} onClick={() => setSelectedId(skill.id)} title={`${skill.name} · ${skill.description}`} type="button">
          <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
          <span className={`skill-source ${skill.source}`}>{skill.source === "built-in" ? "Built-in" : `r${skill.currentRevision}`}</span>
        </button>)}
        {!visibleSkills.length ? <p className="skill-empty">No skills match this search.</p> : null}
      </div>
      <div className="skill-detail">
        {!selectedId ? <p className="skill-empty">Create or import a skill to begin.</p> : !detail ? <p className="skill-empty">Loading skill…</p> : <>
          <header><div><span className={`skill-source ${detail.source}`}>{detail.source === "built-in" ? "Built-in · read-only" : `Managed · revision ${detail.currentRevision}`}</span><h4>{detail.name}</h4><p>{detail.description}</p></div><div className="skill-detail-actions">{!detail.readOnly ? <><button disabled={busy} onClick={openEdit} type="button">Edit</button><button className="danger-button" disabled={busy} onClick={() => void inspectDeletion()} type="button">Delete</button></> : null}</div></header>
          <dl className="skill-metadata"><div><dt>Version</dt><dd>{detail.version}</dd></div><div><dt>Package hash</dt><dd title={detail.hash}>{detail.hash.slice(0, 12)}…</dd></div><div><dt>Resources</dt><dd>{detail.resourceSummary.files} · {detail.resourceSummary.bytes} bytes</dd></div></dl>
          {detail.diagnostics.length ? <div className="skill-diagnostics">{detail.diagnostics.map((diagnostic) => <p key={`${diagnostic.code}-${diagnostic.path ?? ""}`}><strong>{diagnostic.level}</strong> {diagnostic.message}</p>)}</div> : null}
          <section className="skill-instructions"><h5>SKILL.md instructions</h5><pre>{detail.instructions}</pre></section>
          <section className="skill-resources"><h5>Package resources</h5>{detail.resources.length ? <ul>{detail.resources.map((resource) => <li key={resource.path}><button disabled={busy} onClick={() => void previewResource(resource.path)} title={resource.path} type="button">{resource.path}</button><span>{resource.kind} · {resource.size} B</span></li>)}</ul> : <p>No optional resources.</p>}</section>
          {resourcePreview ? <section className="skill-resource-preview"><div><h5>{resourcePreview.path}</h5><button aria-label="Close resource preview" className="icon-button" onClick={() => setResourcePreview(undefined)} title="Close resource preview" type="button"><CloseIcon size={16} /></button></div><pre>{resourcePreview.content}</pre></section> : null}
        </>}
      </div>
    </div>

    {editorMode ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditorMode(undefined); }}>
      <section aria-label={`${editorMode === "create" ? "Create" : "Edit"} skill`} aria-modal="true" className="skill-editor-dialog" role="dialog">
        <span className="eyebrow">Agent Skills format</span><h2>{editorMode === "create" ? "Create skill" : `Edit ${draft.name}`}</h2>
        {draftSourceSummary ? <p className="skill-preservation-note">{draftSourceSummary} This draft is inactive until you save it.</p> : null}
        <form onSubmit={(event) => void saveSkill(event)}>
          <label><span>Name</span><input autoFocus={editorMode === "create"} disabled={editorMode === "edit" || busy} maxLength={64} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="literature-review" required value={draft.name} /></label>
          <label><span>Description</span><textarea maxLength={1024} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} required rows={3} value={draft.description} /></label>
          <div className="skill-editor-columns"><label><span>License (optional)</span><input onChange={(event) => setDraft((current) => ({ ...current, license: event.target.value }))} value={draft.license} /></label><label><span>Version (optional)</span><input onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} placeholder="1.0.0" value={draft.version} /></label></div>
          <label><span>Compatibility (optional)</span><input maxLength={500} onChange={(event) => setDraft((current) => ({ ...current, compatibility: event.target.value }))} value={draft.compatibility} /></label>
          <label><span>Allowed tools (preserved, not enforced)</span><input onChange={(event) => setDraft((current) => ({ ...current, allowedTools: event.target.value }))} value={draft.allowedTools} /></label>
          <label><span>Markdown instructions</span><textarea className="skill-markdown-editor" onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} required rows={13} value={draft.instructions} /></label>
          {editorMode === "edit" && detail?.resources.length ? <p className="skill-preservation-note">The {detail.resources.length} imported resource file(s) will be preserved unchanged.</p> : null}
          {localError ? <p className="skill-manager-error" role="alert">{localError}</p> : null}
          <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setEditorMode(undefined)} type="button">Cancel</button><button className="primary-button" disabled={busy} type="submit">{busy ? "Saving…" : editorMode === "create" ? "Create skill" : "Save new revision"}</button></div>
        </form>
      </section>
    </div> : null}

    {deleteImpact && detail ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteImpact(undefined); }}>
      <section aria-label={`Delete skill ${detail.id}`} aria-modal="true" className="skill-delete-dialog" role="dialog">
        <span className="eyebrow">Managed skill</span><h2>Delete “{detail.id}”?</h2>
        {deleteImpact.references.length ? <><p>This skill is still selected by the following settings and cannot be deleted:</p><ul>{deleteImpact.references.map((reference) => <li key={`${reference.scope}-${reference.id}`}><strong>{reference.scope}</strong> · {reference.label}</li>)}</ul></> : <><p>This removes the skill from the active catalog. Historical run manifests keep their recorded revision and hash.</p><label><span>Type {detail.id} to confirm</span><input onChange={(event) => setDeleteConfirmation(event.target.value)} value={deleteConfirmation} /></label></>}
        <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => setDeleteImpact(undefined)} type="button">Close</button>{!deleteImpact.references.length ? <button className="danger-button" disabled={busy || deleteConfirmation !== detail.id} onClick={() => void confirmDeletion()} type="button">Delete skill</button> : null}</div>
      </section>
    </div> : null}
  </>;
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
}: {
  client: ApiClient;
  onError: (message: string) => void;
}) {
  const [libraries, setLibraries] = useState<SkillLibrary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [versions, setVersions] = useState<SkillLibraryVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [fromVersionId, setFromVersionId] = useState("");
  const [toVersionId, setToVersionId] = useState("");
  const [diff, setDiff] = useState<SkillLibraryDiff>();
  const [libraryName, setLibraryName] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [skillMarkdown, setSkillMarkdown] = useState(DEFAULT_LIBRARY_SKILL);
  const [dryRun, setDryRun] = useState(true);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  const selectedLibrary = libraries.find((library) => library.id === selectedId);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[versions.length - 1];

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
      return;
    }
    let active = true;
    void client.listSkillLibraryVersions(selectedId).then((items) => {
      if (!active) return;
      setVersions(items);
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

  return <>
    <form className="skill-library-create" onSubmit={(event) => void createLibrary(event)}>
      <label><span>Library name</span><input onChange={(event) => setLibraryName(event.target.value)} placeholder="Evaluation skills" value={libraryName} /></label>
      <label><span>Stable id</span><input onChange={(event) => setLibraryId(event.target.value)} placeholder="evaluation-skills" value={libraryId} /></label>
      <button className="primary-button" disabled={busy} type="submit">Create library</button>
    </form>
    {status ? <p className="skill-manager-error" role="status">{status}</p> : null}
    <div className="skill-manager-grid skill-library-grid">
      <div aria-label="Skill libraries" className="skill-catalog-list">
        {libraries.map((library) => {
          const headVersion = versions.find((version) => version.id === library.headVersionId);
          const isSelected = library.id === selectedId;
          return <button aria-label={`Skill library ${library.name}`} className={isSelected ? "skill-card active" : "skill-card"} key={library.id} onClick={() => { setSelectedId(library.id); setDiff(undefined); }} title={library.name} type="button">
          <span><strong>{library.name}</strong><small>{library.headVersionId ? `Head ${library.headVersionId.slice(0, 8)}` : "No published versions"}</small>{isSelected && headVersion ? <small>{headVersion.skills.length} skills · {headVersion.contentHash.slice(0, 12)}</small> : null}</span>
          <span className="skill-source managed">{library.id}</span>
        </button>;
        })}
        {!libraries.length ? <p className="skill-empty">Create a skill library to begin.</p> : null}
      </div>
      <div className="skill-detail skill-library-detail">
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
  </>;
}
