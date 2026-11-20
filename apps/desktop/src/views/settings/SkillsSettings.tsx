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
  setJiuwenSwarmSkillsEnabled,
} from "../../api/settings.js";
import type {
  GitSkillImportJob,
  JiuwenSwarmSkill,
  JiuwenSwarmSkillSwitchResult,
  JiuwenSwarmSkillSwitchTarget,
  SkillDescriptor,
  SkillDetail,
} from "../../api/types.js";
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
  /** JiuwenSwarm's own name for each installed ScienceDiscovery skill. It can
   *  differ from the id: a name JiuwenSwarm already uses renames the import. */
  installedNames: Record<string, string>;
  jiuwenSwarmSkills: JiuwenSwarmSkill[];
  skills: SkillDescriptor[];
}

/** One row a bulk switch covers: its stable key, the target to send, and the
 *  value the page currently shows. */
interface SkillRow {
  key: string;
  name: string;
  skillId?: string;
  target: JiuwenSwarmSkillSwitchTarget;
}

/** The key a row's optimistic intent is kept under. Ids and JiuwenSwarm names
 *  are separate namespaces: a catalog skill and a JiuwenSwarm skill can share a name. */
function catalogKey(skillId: string): string {
  return `id:${skillId}`;
}

function jiuwenKey(name: string): string {
  return `name:${name}`;
}

function withoutKey(intent: Record<string, boolean>, key: string): Record<string, boolean> {
  const next = { ...intent };
  delete next[key];
  return next;
}

/** What the last server answer says about a row, or undefined if the row is gone. */
function serverValue(page: SkillPage, key: string): boolean | undefined {
  if (key.startsWith("id:")) return page.enabled.includes(key.slice(3));
  return page.jiuwenSwarmSkills.find((skill) => skill.name === key.slice(5))?.enabled;
}

/**
 * Every row a bulk action covers, with the target to send for it.
 *
 * A catalog skill brings the JiuwenSwarm name it is installed as when the page
 * knows it, which is what keeps the bulk write free of a lookup per skill. A
 * skill JiuwenSwarm does not have yet goes by id, and the server imports it
 * only if the action needs it there.
 */
function skillRows(page: SkillPage): SkillRow[] {
  return [
    ...page.skills.map((skill): SkillRow => ({
      key: catalogKey(skill.id),
      name: skill.name,
      skillId: skill.id,
      target: {
        skillId: skill.id,
        ...(page.installedNames?.[skill.id] === undefined ? {} : { name: page.installedNames[skill.id] }),
      },
    })),
    ...page.jiuwenSwarmSkills.map((skill): SkillRow => ({
      key: jiuwenKey(skill.name),
      name: skill.name,
      target: { name: skill.name },
    })),
  ];
}

/** The result that belongs to a row: by id when its target had one, else by name. */
function resultFor(row: SkillRow, results: readonly JiuwenSwarmSkillSwitchResult[]): JiuwenSwarmSkillSwitchResult | undefined {
  return row.skillId === undefined
    ? results.find((result) => result.skillId === undefined && result.name === row.name)
    : results.find((result) => result.skillId === row.skillId);
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
  const [bulkPending, setBulkPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  // A switch moves the moment it is pressed, on the intent the user expressed;
  // the server's answer replaces that intent, and a refusal puts the row back.
  const [intent, setIntent] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
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
      installedNames: Object.fromEntries((jiuwenSwarm?.skills ?? []).flatMap((skill) => (
        skill.skillId === undefined ? [] : [[skill.skillId, skill.name]]
      ))),
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

  // A fresh server answer is the truth: an intent it already agrees with is
  // spent, and one it still disagrees with belongs to a write in flight (or to
  // a row whose write failed, which was put back explicitly).
  const page = loaded.value;
  useEffect(() => {
    if (!page) return;
    setIntent((current) => Object.fromEntries(
      Object.entries(current).filter(([key, value]) => serverValue(page, key) !== value),
    ));
  }, [page]);

  const toggle = async (key: string, skill: SkillDescriptor | JiuwenSwarmSkill, next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    setFailure(undefined);
    setIntent((current) => ({ ...current, [key]: next }));
    setPending((current) => new Set(current).add(key));
    try {
      await setSkillEnabled(client, skill, next);
    } catch (reason) {
      // Back to the value the server last confirmed: a refused switch must not
      // leave the row showing a state JiuwenSwarm does not have.
      setIntent((current) => withoutKey(current, key));
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setPending((current) => {
        const remaining = new Set(current);
        remaining.delete(key);
        return remaining;
      });
      loaded.reload();
    }
  };

  /**
   * Enable or disable every listed skill in one request.
   *
   * The rows move first, on the intent, and the single write follows; its
   * per-target answer puts back exactly the rows JiuwenSwarm refused, and one
   * list read afterwards reconciles the page. The row switches stay disabled
   * while `bulkPending` is set, that is until the batch write settles: a switch
   * pressed in that window would race the batch. Once it settles a switch is an
   * ordinary single write, and the reload started below reconciles the page.
   * A page of 31 skills used to be 31 awaited requests plus its own reload,
   * which is what froze it for seconds.
   */
  const setAll = async (next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    const rows = skillRows(page);
    if (!rows.length) return;
    setFailure(undefined);
    setBulkPending(true);
    setIntent(Object.fromEntries(rows.map((row) => [row.key, next])));
    try {
      const answer = await setJiuwenSwarmSkillsEnabled(client, rows.map((row) => row.target), next);
      const refused = rows.flatMap((row) => {
        const result = resultFor(row, answer.results);
        return result?.ok === false ? [{ key: row.key, name: row.name, reason: result.error }] : [];
      });
      if (refused.length) {
        const refusedKeys = new Set(refused.map((entry) => entry.key));
        setIntent((current) => Object.fromEntries(
          Object.entries(current).filter(([key]) => !refusedKeys.has(key)),
        ));
        setFailure(refused
          .map((entry) => `${entry.name}: ${entry.reason ?? TEXT.settings.saveFailed}`)
          .join("\n"));
      }
    } catch (reason) {
      // The write did not land as a whole: every row goes back to the server's
      // value, and the reload below paints what the server actually holds.
      setIntent({});
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBulkPending(false);
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
                    : page.switchesAvailable
                      ? <BulkToggles busy={busy || bulkPending} onAll={(next) => void setAll(next)} />
                      : null}
                {skills.map((skill) => {
                  const key = catalogKey(skill.id);
                  const on = intent[key] ?? page.enabled.includes(skill.id);
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
                          disabled={busy || !page.switchesAvailable || bulkPending || pending.has(key)}
                          label={TEXT.settings.skills.toggle(skill.name)}
                          onChange={(next) => void toggle(key, skill, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
                {jiuwenSwarmSkills.map((skill) => {
                  const key = jiuwenKey(skill.name);
                  const on = intent[key] ?? skill.enabled;
                  return (
                    <div className="settings-card" key={`jiuwenswarm:${skill.name}`}>
                      <span className="settings-card-mark">{skillMark(skill)}</span>
                      <div className="settings-card-main">
                        <strong>
                          {skill.name}
                          <Tag tone={on ? "on" : "off"}>
                            {on ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                          </Tag>
                        </strong>
                        <small>{skill.description}</small>
                        <span className={`skill-source-badge ${skill.source === "builtin" ? "is-jiuwenswarm" : "is-managed"}`}>
                          {skill.source === "builtin" ? TEXT.settings.skills.source.jiuwenBuiltIn : TEXT.settings.skills.source.jiuwenLocal}
                        </span>
                      </div>
                      <div className="settings-card-actions">
                        <Switch
                          disabled={busy || !page.switchesAvailable || bulkPending || pending.has(key)}
                          label={TEXT.settings.skills.toggle(skill.name)}
                          onChange={(next) => void toggle(key, skill, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
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
