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

import { useEffect, useRef, useState } from "react";

import { ApiRequestError, type ApiClient } from "../../api/client.js";
import {
  deleteSkill,
  exportSkillPackage,
  getJiuwenSwarmSkills,
  getSkillDeletionImpact,
  listSkills,
  setJiuwenSwarmSkillEnabled,
  setJiuwenSwarmSkillEnabledById,
} from "../../api/settings.js";
import type { GitSkillImportJob, JiuwenSwarmSkill, SkillDescriptor, SkillDetail } from "../../api/types.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import {
  dismissGitSkillImportJob,
  enableCreatedSkills,
  startGitSkillImportInBackground,
  subscribeGitSkillImportJob,
} from "../../app/git-skill-import-job.js";
import { saveSkillPackage } from "../../app/skill-export.js";
import { skillMark } from "../../app/slash.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { SkillAddMenu } from "./SkillAddMenu.js";
import { SkillDetailView } from "./SkillDetailView.js";
import { SkillEditorView } from "./SkillEditorView.js";
import { SkillForm } from "./SkillForm.js";
import { SkillGitImportView } from "./SkillGitImportView.js";
import { SkillRowMenu, type SkillRowAction } from "./SkillRowMenu.js";
import { SkillUploadView } from "./SkillUploadView.js";
import { BulkToggles, Group, LoadGate, Switch, Tag } from "./rows.js";

interface Props {
  client: ApiClient;
  /** The workspace's one confirmation dialog. A package is deleted only
   *  through it; without it the pane does not offer a deletion at all. */
  onConfirm?: (request: ConfirmRequest) => void;
}

/**
 * Which page of 技能 is showing.
 *
 * Adding and editing used to be modal forms over the list. A Skill is a small
 * document with files, though, and a modal put the list one layer away from
 * the thing the user was comparing it with; the pane now swaps instead, and
 * the header's back control is the only way out of any page below `list`.
 */
type SkillView =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "upload" }
  | { kind: "git" }
  | { description: string; id: string; kind: "detail"; name: string }
  | { id: string; kind: "edit"; name: string };

interface SkillPage {
  switchesAvailable: boolean;
  switchError?: string;
  native: boolean;
  enabled: string[];
  jiuwenSwarmSkills: JiuwenSwarmSkill[];
  skills: SkillDescriptor[];
}

function setSkillEnabled(client: ApiClient, skill: SkillDescriptor | JiuwenSwarmSkill, enabled: boolean): Promise<void> {
  return "id" in skill
    ? setJiuwenSwarmSkillEnabledById(client, skill.id, enabled)
    : setJiuwenSwarmSkillEnabled(client, skill.name, enabled);
}

function sourceLabel(source: SkillDescriptor["source"]): string {
  return source === "built-in" ? TEXT.settings.skills.source.builtIn : TEXT.settings.skills.source.managed;
}

/** The title and one-line description of a page below the list. Read through
 *  TEXT at render time so a language change renames the page it is showing. */
function subviewCopy(view: Exclude<SkillView, { kind: "list" }>): { description: string; title: string } {
  switch (view.kind) {
    case "create":
      return TEXT.settings.skills.createView;
    case "upload":
      return TEXT.settings.skills.uploadView;
    case "git":
      return TEXT.settings.skills.git;
    case "detail":
      return { description: view.description, title: view.name };
    case "edit":
      return {
        description: TEXT.settings.skills.editor.hint,
        title: TEXT.settings.skills.editor.title(view.name),
      };
  }
}

/**
 * 设置 › 技能.
 *
 * The enabled set is read from JiuwenSwarm's own skill store: it is the global
 * authority for whether a skill is available, and it applies to every project.
 * ScienceDiscovery only installs or removes the skill package; the switch lives
 * in JiuwenSwarm.
 *
 * The pane draws its own header because 添加技能 changes what is below it: the
 * title row travels with the page it names, so a sub-page never sits under a
 * header that still says the list is open.
 */
export function SkillsSettings({ client, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [exportStatus, setExportStatus] = useState<{
    error?: boolean;
    id: string;
    message: string;
  }>();
  const [backgroundImport, setBackgroundImport] = useState<GitSkillImportJob>();
  const handledImportJob = useRef<string | undefined>(undefined);

  // An export's outcome is a passing confirmation, not a property of the row:
  // it says what just happened, then leaves. A failure stays long enough to be
  // read, and disappears the same way; the failed export itself changed
  // nothing.
  useEffect(() => {
    if (!exportStatus) return;
    const timer = setTimeout(() => setExportStatus(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [exportStatus]);

  // The Git import keeps running in the API while the reader is elsewhere;
  // this pane only watches it. Once it ends, new packages are switched on in
  // JiuwenSwarm (as a foreground import did) and the catalog is re-read once.
  useEffect(() => subscribeGitSkillImportJob(setBackgroundImport), []);
  const [view, setView] = useState<SkillView>({ kind: "list" });

  const loaded = useLoaded<SkillPage>(async () => {
    const [catalog, state] = await Promise.allSettled([
      listSkills(client),
      getJiuwenSwarmSkills(client),
    ]);
    if (catalog.status === "rejected") throw catalog.reason;
    const jiuwenSwarm = state.status === "fulfilled" ? state.value : undefined;
    return {
      enabled: catalog.value.flatMap((skill) => {
        const installed = jiuwenSwarm?.skills.find((entry) => entry.skillId === skill.id);
        return (installed ? installed.enabled : skill.source === "built-in") ? [skill.id] : [];
      }),
      jiuwenSwarmSkills: jiuwenSwarm?.skills.filter((skill) => skill.source !== "sciencediscovery") ?? [],
      native: jiuwenSwarm?.backend === "native",
      skills: catalog.value,
      switchesAvailable: jiuwenSwarm?.backend === "jiuwenswarm",
      ...(state.status === "rejected" ? {
        switchError: state.reason instanceof Error ? state.reason.message : TEXT.settings.saveFailed,
      } : {}),
    };
  }, {
    client,
    key: "skills:jiuwenswarm",
  });

  useEffect(() => {
    if (!backgroundImport) return;
    const terminal = backgroundImport.status === "done"
      || backgroundImport.status === "cancelled"
      || backgroundImport.status === "failed";
    if (!terminal || handledImportJob.current === backgroundImport.id) return;
    handledImportJob.current = backgroundImport.id;
    // Enabling newly created packages is the job store's work: the pane may
    // be closed when the import ends. When the pane is open, wait for that
    // same run before re-reading the switch list; otherwise the reload can
    // paint the new rows as off while the PUTs are still in flight.
    void (async () => {
      await enableCreatedSkills(client, backgroundImport);
      loaded.reload();
    })();
  }, [backgroundImport, client, loaded]);

  const toggle = async (skill: SkillDescriptor | JiuwenSwarmSkill, next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await setSkillEnabled(client, skill, next);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /**
   * Enable or disable every installed skill. Each toggle is its own request:
   * JiuwenSwarm is the authority, and a single failing skill must not stop the
   * rest from being applied.
   */
  const setAll = async (next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const failures: string[] = [];
      for (const skill of [...page.skills, ...page.jiuwenSwarmSkills]) {
        try {
          await setSkillEnabled(client, skill, next);
        } catch (reason) {
          failures.push(`${skill.name}: ${reason instanceof Error ? reason.message : TEXT.settings.saveFailed}`);
        }
      }
      if (failures.length) setFailure(failures.join("\n"));
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /** Save the package as a ZIP under a name the user picks. A cancelled save
   *  is not a failure, and the pane says nothing about it. */
  const exportSkill = async (skill: SkillDescriptor) => {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    setExportStatus(undefined);
    try {
      const bytes = await exportSkillPackage(client, skill.id);
      if (await saveSkillPackage(skill.name, bytes)) {
        setExportStatus({ id: skill.id, message: TEXT.settings.skills.rowMenu.exported(skill.name) });
      }
    } catch (reason) {
      // The row says what went wrong: the page's own notice sits above the
      // list, and a reader who scrolled to a row would not see it.
      const message = reason instanceof ApiRequestError && reason.status === 404
        ? TEXT.settings.skills.rowMenu.exportUnsupported
        : reason instanceof Error ? reason.message : TEXT.settings.skills.rowMenu.exportFailed;
      setExportStatus({ error: true, id: skill.id, message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete an installed package, after the server confirms nothing still
   * selects it.
   *
   * The reference check happens first: a package named by a Project or Session
   * selection would leave that document pointing at something gone, so the
   * route refuses it, and asking first turns that refusal into a sentence
   * naming the count instead of a failed request.
   */
  const removeSkill = async (skill: SkillDescriptor) => {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      const impact = await getSkillDeletionImpact(client, skill.id);
      if (impact.references.length > 0) {
        setFailure(TEXT.settings.skills.rowMenu.deleteBlocked(skill.name, impact.references.length));
        return;
      }
      if (!onConfirm) return;
      onConfirm({
        accept: TEXT.menu.delete,
        body: TEXT.settings.skills.rowMenu.deleteBody(skill.name),
        eyebrow: TEXT.settings.skills.heading,
        onAccept: async () => {
          setBusy(true);
          try {
            await deleteSkill(client, skill.id);
            setNotice(TEXT.settings.skills.rowMenu.deleted(skill.name));
          } catch (reason) {
            setFailure(reason instanceof Error ? reason.message : TEXT.settings.skills.rowMenu.deleteFailed);
          } finally {
            setBusy(false);
            loaded.reload();
          }
        },
        title: TEXT.settings.skills.rowMenu.deleteTitle(skill.name),
      });
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.skills.rowMenu.deleteFailed);
    } finally {
      setBusy(false);
    }
  };

  const chooseRowAction = (skill: SkillDescriptor, action: SkillRowAction) => {
    if (action === "export") void exportSkill(skill);
    else if (action === "edit") setView({ id: skill.id, kind: "edit", name: skill.name });
    else void removeSkill(skill);
  };

  /**
   * Enable a skill that was just installed, when JiuwenSwarm is available —
   * a new package is useless to a session until it is switched on.
   *
   * An *update* of a skill that was already installed is left alone: the user
   * may have switched it off on purpose, and re-enabling it would undo that
   * while replacing its files, which is not what they asked for.
   */
  const afterInstall = async (skill: SkillDetail) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const page = loaded.value;
      const wasInstalled = page?.skills.some((entry) => entry.id === skill.id) ?? false;
      if (page?.switchesAvailable) {
        if (!wasInstalled) await setJiuwenSwarmSkillEnabledById(client, skill.id, true);
      } else if (!page?.native && !wasInstalled) {
        setFailure(page?.switchError ?? TEXT.settings.saveFailed);
      }
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /** Enable a new skill when JiuwenSwarm is available; native creation needs no import. */
  const afterCreate = async (skill: SkillDetail) => {
    // A created package is a list item from now on, and the list is where the
    // user would go to look at it, so the form does not linger.
    setView({ kind: "list" });
    await afterInstall(skill);
  };

  const installed = loaded.value
    ? loaded.value.skills.length + loaded.value.jiuwenSwarmSkills.length
    : undefined;
  const copy = view.kind === "list" ? undefined : subviewCopy(view);
  const back = () => setView({ kind: "list" });

  const header = view.kind === "list" ? (
    <header className="settings-detail-header">
      <div>
        <h3>
          {TEXT.settings.system.groups.skills.label}
          {installed === undefined ? null : (
            <span className="skill-installed-count">
              {TEXT.settings.skills.installedCount(installed)}
            </span>
          )}
        </h3>
        <p>{TEXT.settings.system.groups.skills.description}</p>
      </div>
      <SkillAddMenu onChoose={(choice) => setView({ kind: choice })} />
    </header>
  ) : view.kind === "detail" || view.kind === "edit" ? null : (() => {
    const pageCopy = subviewCopy(view);
    return (
      <header className="settings-detail-header skill-subview-head">
        <div className="skill-subview-copy">
          <h3>{pageCopy.title}</h3>
          <p>{pageCopy.description}</p>
        </div>
      </header>
    );
  })();

  // The way out sits in a bar across the pane's top, as it does in the settings
  // shell this pane imitates: outside the scrolling content, so a long SKILL.md
  // cannot carry the trail away, and out of the page's own column, so the name
  // and description start where 文件 does.
  const trail = copy === undefined ? null : (
    <div className="skill-pane-bar">
      <button
        aria-label={TEXT.settings.skills.backToList}
        className="skill-pane-back"
        onClick={back}
        type="button"
      >
        <svg fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24" width="15">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <span aria-hidden="true" className="skill-pane-divider" />
      <nav aria-label={TEXT.settings.system.groups.skills.label} className="skill-breadcrumb">
        <button onClick={back} type="button">{TEXT.settings.system.groups.skills.label}</button>
        <span aria-hidden="true">›</span>
        <span className="skill-breadcrumb-current">{copy.title}</span>
      </nav>
    </div>
  );

  return (
    <div className="skill-pane">
      {trail}
      <div className={`settings-group-detail${view.kind === "edit" ? " is-skill-editor" : ""}`}>
      {header}
      {view.kind === "list" && backgroundImport ? (
        <div
          className={`skill-import-banner${backgroundImport.status === "failed" ? " is-error" : ""}`}
          role={backgroundImport.status === "failed" ? "alert" : "status"}
        >
          <div className="skill-import-banner-copy">
            <strong>
              {backgroundImport.status === "queued" || backgroundImport.status === "running"
                ? TEXT.settings.skills.backgroundImportRunning(
                  backgroundImport.done,
                  backgroundImport.total,
                )
                : backgroundImport.status === "failed"
                  ? TEXT.settings.skills.backgroundImportFailed
                  : backgroundImport.failures.length
                    ? TEXT.settings.skills.backgroundImportPartial(
                      backgroundImport.imported.length,
                      backgroundImport.failures.length,
                    )
                    : TEXT.settings.skills.backgroundImportDone(backgroundImport.imported.length)}
            </strong>
            {backgroundImport.failures.length ? (
              <small>
                {TEXT.settings.skills.backgroundImportFailures(
                  backgroundImport.failures.slice(0, 3).map((failure) => failure.subdirectory).join("、"),
                  backgroundImport.failures.length,
                )}
              </small>
            ) : null}
          </div>
          {backgroundImport.status === "queued" || backgroundImport.status === "running" ? null : (
            <button
              aria-label={TEXT.settings.skills.backgroundImportDismiss}
              className="skill-import-banner-close"
              onClick={() => dismissGitSkillImportJob()}
              type="button"
            >
              ×
            </button>
          )}
        </div>
      ) : null}
      {view.kind === "list" ? (
        <div className="skill-search-row">
          <input
            aria-label={TEXT.settings.skills.search}
            className="skill-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={TEXT.settings.skills.searchPlaceholder}
            type="search"
            value={query}
          />
        </div>
      ) : null}
      {view.kind === "list" ? (
      <Group>
        <p className="row-note">{TEXT.settings.skills.scope}</p>
        {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
        {notice ? <small className="row-note" role="status">{notice}</small> : null}
        <LoadGate loaded={loaded}>
          {(page) => {
            const term = query.trim().toLowerCase();
            const matches = (name: string, description: string) =>
              term === "" || name.toLowerCase().includes(term) || description.toLowerCase().includes(term);
            const skills = page.skills.filter((skill) => matches(skill.name, skill.description));
            const jiuwenSwarmSkills = page.jiuwenSwarmSkills.filter((skill) => matches(skill.name, skill.description));
            const noMatches = term !== "" && skills.length === 0 && jiuwenSwarmSkills.length === 0;
            return (
              <div className="settings-list">
                {page.native ? <p className="row-note">{TEXT.settings.skills.jiuwenSwarmOnly}</p> : null}
                {page.switchError ? <div className="row-note is-error" role="alert">
                  {page.switchError}
                  <button className="bulk-button" disabled={loaded.loading} onClick={() => { setFailure(undefined); loaded.reload(); }} type="button">
                    {TEXT.settings.retry}
                  </button>
                </div> : null}
                {page.skills.length === 0 && page.jiuwenSwarmSkills.length === 0
                  ? <p className="settings-empty">{TEXT.settings.skills.empty}</p>
                  : noMatches
                    ? <p className="settings-empty">{TEXT.settings.skills.noMatches}</p>
                    : page.switchesAvailable ? <BulkToggles busy={busy} onAll={(next) => void setAll(next)} /> : null}
                {skills.map((skill) => {
                  const on = page.enabled.includes(skill.id);
                  return (
                    <div className="settings-card" key={skill.id}>
                      <span className="settings-card-mark">{skillMark(skill)}</span>
                      <button
                        className="settings-card-main"
                        onClick={() => setView({
                          description: skill.description,
                          id: skill.id,
                          kind: "detail",
                          name: skill.name,
                        })}
                        type="button"
                      >
                        <strong>
                          {skill.name}
                          {page.switchesAvailable ? <Tag tone={on ? "on" : "off"}>
                            {on ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                          </Tag> : null}
                        </strong>
                        <small>{skill.description}</small>
                        <span className={`skill-source-badge ${skill.source === "built-in" ? "is-sd" : "is-managed"}`}>
                          {sourceLabel(skill.source)}
                        </span>
                      </button>
                      {exportStatus?.id === skill.id ? (
                        <span
                          className={`skill-export-status${exportStatus.error ? " is-error" : ""}`}
                          role={exportStatus.error ? "alert" : "status"}
                        >
                          {exportStatus.message}
                        </span>
                      ) : null}
                      <div className="settings-card-actions">
                        {skill.source === "managed" || skill.source === "built-in" ? (
                          <SkillRowMenu
                            canDelete={skill.source === "managed"}
                            canEdit={skill.source === "managed" && !skill.readOnly}
                            disabled={busy}
                            name={skill.name}
                            onAction={(action) => chooseRowAction(skill, action)}
                          />
                        ) : null}
                        <Switch
                          disabled={busy || !page.switchesAvailable}
                          label={TEXT.settings.skills.toggle(skill.name)}
                          onChange={(next) => void toggle(skill, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
                {jiuwenSwarmSkills.map((skill) => (
                  <div className="settings-card" key={`jiuwenswarm:${skill.name}`}>
                    <span className="settings-card-mark">{skillMark(skill)}</span>
                    <div className="settings-card-main">
                      <strong>
                        {skill.name}
                        <Tag tone={skill.enabled ? "on" : "off"}>
                          {skill.enabled ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                        </Tag>
                      </strong>
                      <small>{skill.description}</small>
                      <span className={`skill-source-badge ${skill.source === "builtin" ? "is-jiuwenswarm" : "is-managed"}`}>
                        {skill.source === "builtin" ? TEXT.settings.skills.source.jiuwenBuiltIn : TEXT.settings.skills.source.jiuwenLocal}
                      </span>
                    </div>
                    <div className="settings-card-actions">
                      <Switch
                        disabled={busy || !page.switchesAvailable}
                        label={TEXT.settings.skills.toggle(skill.name)}
                        onChange={(next) => void toggle(skill, next)}
                        value={skill.enabled}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          }}
        </LoadGate>
      </Group>
      ) : null}

      {view.kind === "create" ? (
        <div className="skill-create">
          <SkillForm client={client} onSaved={(skill) => void afterCreate(skill)} />
        </div>
      ) : null}

      {view.kind === "upload" ? (
        <SkillUploadView
          client={client}
          onImported={afterInstall}
          onWriteInstead={() => setView({ kind: "create" })}
        />
      ) : null}

      {view.kind === "git" ? (
        <SkillGitImportView
          client={client}
          onDone={() => setView({ kind: "list" })}
          onStart={async (request) => {
            await startGitSkillImportInBackground(client, request);
          }}
        />
      ) : null}

      {view.kind === "detail" ? (
        <SkillDetailView client={client} skillId={view.id} />
      ) : null}

      {view.kind === "edit" ? (
        <SkillEditorView
          client={client}
          onCancel={back}
          onSaved={() => loaded.reload()}
          skillId={view.id}
        />
      ) : null}
      </div>
    </div>
  );
}
