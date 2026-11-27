// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import type { ApiClient } from "../../../api/client.js";
import { deleteSpecialist, listConnectors, listSkills, listSpecialists, updateSpecialist } from "../../../api/settings.js";
import type { ConnectorManifest, SkillDescriptor, Specialist } from "../../../api/types.js";
import type { ConfirmRequest } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { useTopmostEscape } from "../../use-dialog-escape.js";
import { BulkToggles, LoadGate, Switch } from "../rows.js";
import { SpecialistForm } from "./SpecialistForm.js";
import { SpecialistActions, SpecialistGlyph, SpecialistMark, SpecialistSearch, SpecialistSourceTabs, type SpecialistSource } from "./SpecialistParts.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  onSubpageChange?: (open: boolean) => void;
  onTry?: (specialist: Specialist, prompt?: string) => Promise<void>;
}
interface Page { connectors: ConnectorManifest[]; skills: SkillDescriptor[]; specialists: Specialist[] }
type View = { kind: "list" } | { kind: "create" } | { kind: "detail" | "edit"; specialist: Specialist };

function Badges({ specialist }: { specialist: Specialist }) {
  const labels = TEXT.settings.system.specialists;
  const all = specialist.enabledSkillIds.length + specialist.connectorIds.length === 0;
  return <span className="specialist-badges"><span className="specialist-badge">{specialist.builtIn ? labels.builtIn : labels.external}</span>
    {all ? <span className="specialist-badge">{labels.allCapabilities}</span> : <><span className="specialist-badge">ϟ {labels.skills} {specialist.enabledSkillIds.length}</span><span className="specialist-badge">▧ MCP {specialist.connectorIds.length}</span></>}
  </span>;
}

function SpecialistDetail({ specialist, page, busy, onBack, onEdit, onToggle, onDelete, onTry }: {
  specialist: Specialist; page: Page; busy: boolean; onBack: () => void; onEdit: () => void;
  onToggle: (next: boolean) => void; onDelete: () => void; onTry: (prompt?: string) => void;
}) {
  const labels = TEXT.settings.system.specialists, enabled = specialist.enabled !== false;
  useTopmostEscape(() => { if (!busy) onBack(); });
  return <section className="specialist-subpage" role="region" aria-label={labels.details}>
    <div className="specialist-subpage-content">
      <button className="specialist-back" type="button" disabled={busy} onClick={onBack}><SpecialistGlyph kind="back" />{labels.back}</button>
      <header className="specialist-detail-head"><div className="specialist-identity"><SpecialistMark name={specialist.name} /><div><h2>{specialist.name}</h2><Badges specialist={specialist} /></div></div>
        <div className="specialist-detail-actions">
          {!specialist.builtIn ? <button className="specialist-text-button" type="button" disabled={busy} onClick={onEdit}>{TEXT.settings.skills.rowMenu.edit}</button> : null}
          <label className="specialist-enabled"><Switch label={`${specialist.name} · ${labels.enabled}`} disabled={busy} value={enabled} onChange={onToggle} /><span>{enabled ? labels.enabled : labels.disabled}</span></label>
          <button className="pill-button" type="button" disabled={busy || !enabled} title={!enabled ? labels.tryDisabled : undefined} onClick={() => onTry()}>{labels.try}</button>
          <SpecialistActions name={specialist.name} enabled={enabled} canDelete={!specialist.builtIn} busy={busy} onTry={() => onTry()} onDelete={onDelete} />
        </div>
      </header>
      <div className="specialist-detail-body">
        <section><h3>{labels.description}</h3><p>{specialist.description}</p></section>
        <section><h3>{labels.instructions}</h3><p className="specialist-full-instructions">{specialist.instructions}</p></section>
        <section><h3>{labels.runtime}</h3><span className="specialist-badge">{!specialist.runtime || specialist.runtime.kind === "native" ? labels.runtimeNative : specialist.runtime.kind}</span>{specialist.runtime && specialist.runtime.kind !== "native" && specialist.runtime.model ? <p>{specialist.runtime.model}</p> : null}</section>
        {specialist.enabledSkillIds.length + specialist.connectorIds.length === 0 ? <section><h3>{labels.capabilities}</h3><p>{labels.fullAccessHint}</p></section> : <>
          <section><h3>{labels.skills}</h3><div className="specialist-capability-chips">{specialist.enabledSkillIds.map(id => { const skill = page.skills.find(s => s.id === id); return <span className="specialist-capability-chip" key={id}><SpecialistMark small name={skill?.name ?? id} />{skill?.name ?? labels.unavailableSkill(id)}</span>; })}</div></section>
          <section><h3>{labels.mcpConfiguration}</h3><div className="specialist-capability-chips">{specialist.connectorIds.map(id => { const connector = page.connectors.find(c => c.id === id); return <span className="specialist-capability-chip" key={id}><SpecialistMark small name={connector?.displayName ?? id} />{connector?.displayName ?? id}</span>; })}</div></section>
        </>}
        {(specialist.promptExamples?.length ?? 0) > 0 ? <section><h3>{labels.promptExamples}</h3><div className="specialist-example-list">{specialist.promptExamples!.map((example, index) => <button type="button" key={index} disabled={busy || !enabled} title={!enabled ? labels.tryDisabled : labels.exampleTry} onClick={() => onTry(example)}><span>“{example}”</span><SpecialistGlyph kind="try" /></button>)}</div></section> : null}
      </div>
    </div>
  </section>;
}

export function SpecialistsSettings({ client, onConfirm, onSubpageChange, onTry }: Props) {
  const loaded = useLoaded<Page>(async () => { const [specialists, connectors, skills] = await Promise.all([listSpecialists(client), listConnectors(client), listSkills(client)]); return { specialists, connectors, skills }; }, { client, key: "specialists" });
  const [view, setView] = useState<View>({ kind: "list" });
  const [source, setSource] = useState<SpecialistSource>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const labels = TEXT.settings.system.specialists;
  useEffect(() => { onSubpageChange?.(view.kind !== "list"); }, [view.kind, onSubpageChange]);
  const report = (reason: unknown) => setNotice({ error: true, message: reason instanceof Error ? reason.message : TEXT.settings.saveFailed });
  const toggle = async (specialist: Specialist, next: boolean) => {
    setBusy(true); setNotice(undefined);
    try {
      const saved = await updateSpecialist(client, specialist.id, { enabled: next });
      setView(current => current.kind === "detail" && current.specialist.id === saved.id ? { kind: "detail", specialist: saved } : current);
      loaded.reload();
    } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const setAll = async (next: boolean) => {
    if (!loaded.value) return;
    setBusy(true); setNotice(undefined);
    try { for (const specialist of loaded.value.specialists) if ((specialist.enabled !== false) !== next) await updateSpecialist(client, specialist.id, { enabled: next }); }
    catch (reason) { report(reason); } finally { loaded.reload(); setBusy(false); }
  };
  const remove = (specialist: Specialist) => onConfirm({ accept: TEXT.menu.delete, body: labels.deleteBody(specialist.name), eyebrow: labels.heading, title: labels.deleteTitle(specialist.name), onAccept: () => {
    setBusy(true); setNotice(undefined);
    void deleteSpecialist(client, specialist.id).then(() => { setView({ kind: "list" }); setNotice({ error: false, message: labels.deleted }); loaded.reload(); }).catch(report).finally(() => setBusy(false));
  } });
  const tryRole = async (specialist: Specialist, prompt?: string) => {
    if (busy || specialist.enabled === false || !onTry) return;
    setBusy(true); setNotice(undefined);
    try { await onTry(specialist, prompt); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  return <LoadGate loaded={loaded}>{page => <>
    {view.kind === "create" || view.kind === "edit" ? <SpecialistForm client={client} connectors={page.connectors} skills={page.skills} specialist={view.kind === "edit" ? view.specialist : undefined}
      onCancel={() => setView(view.kind === "edit" ? { kind: "detail", specialist: view.specialist } : { kind: "list" })}
      onSaved={saved => { setNotice({ error: false, message: view.kind === "create" ? labels.created : labels.updated }); setView({ kind: "detail", specialist: saved }); loaded.reload(); }} />
      : view.kind === "detail" ? <SpecialistDetail specialist={view.specialist} page={page} busy={busy} onBack={() => setView({ kind: "list" })} onEdit={() => setView({ kind: "edit", specialist: view.specialist })} onToggle={next => void toggle(view.specialist, next)} onDelete={() => remove(view.specialist)} onTry={prompt => void tryRole(view.specialist, prompt)} />
        : <div className="specialist-page">
          <header className="specialist-page-heading"><h2>{labels.heading}</h2><p>{labels.help}</p></header>
          <div className="specialist-toolbar"><SpecialistSourceTabs value={source} onChange={setSource} counts={{ all: page.specialists.length, mine: page.specialists.filter(s => !s.builtIn).length, official: page.specialists.filter(s => s.builtIn).length }} />
            <div className="specialist-toolbar-actions"><BulkToggles busy={busy || page.specialists.length === 0} onAll={next => void setAll(next)} /><SpecialistSearch value={query} onChange={setQuery} /><button className="pill-button is-dark" disabled={busy} type="button" onClick={() => { setNotice(undefined); setView({ kind: "create" }); }}>{labels.add}</button></div>
          </div>
          <div className="specialist-grid">
            {page.specialists.filter(s => (source === "all" || Boolean(s.builtIn) === (source === "official")) && `${s.name} ${s.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(specialist => <article className="specialist-card settings-card" key={specialist.id}>
              <button className="specialist-card-open" type="button" aria-label={labels.view(specialist.name)} onClick={() => { setNotice(undefined); setView({ kind: "detail", specialist }); }}>
                <span className="specialist-identity"><SpecialistMark name={specialist.name} /><span><strong>{specialist.name}</strong><Badges specialist={specialist} /></span></span><span className="specialist-card-description">{specialist.description}</span>
              </button>
              <div className="specialist-card-controls"><Switch disabled={busy} label={`${specialist.name} · ${labels.enabled}`} value={specialist.enabled !== false} onChange={next => void toggle(specialist, next)} /><SpecialistActions name={specialist.name} enabled={specialist.enabled !== false} canDelete={!specialist.builtIn} busy={busy} onTry={() => void tryRole(specialist)} onDelete={() => remove(specialist)} /></div>
            </article>)}
          </div>
          {page.specialists.filter(s => (source === "all" || Boolean(s.builtIn) === (source === "official")) && `${s.name} ${s.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).length === 0 ? <p className="specialist-empty">{labels.noResults}</p> : null}
          <p className="specialist-reviewer-note" data-testid="built-in-reviewer">{TEXT.reviewer.title} · {labels.reviewerUse}</p>
        </div>}
    {notice ? <div className={`specialist-notice${notice.error ? " is-error row-note" : " is-success"}`} role={notice.error ? "alert" : "status"}><span>{notice.message}</span><button type="button" aria-label={TEXT.settings.close} onClick={() => setNotice(undefined)}>×</button></div> : null}
  </>}</LoadGate>;
}
