// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useState } from "react";
import type { ApiClient } from "../../../api/client.js";
import { createSpecialist, updateSpecialist } from "../../../api/settings.js";
import type { ConnectorManifest, CreateSpecialistRequest, SkillDescriptor, Specialist, SpecialistRuntime } from "../../../api/types.js";
import { TEXT } from "../../../text.js";
import { claimsEscape } from "../../dialog-escape.js";
import { AbilityPicker, selectableSkills, type AbilityTab } from "./AbilityPicker.js";
import { SpecialistGlyph, SpecialistMark } from "./SpecialistParts.js";

interface Props {
  client: ApiClient;
  connectors: ConnectorManifest[];
  onCancel: () => void;
  onSaved: (specialist: Specialist) => void;
  specialist?: Specialist;
  skills: SkillDescriptor[];
}
type RuntimeKind = "native" | "codex" | "claude-code" | "acp";

export function SpecialistForm({ client, connectors, onCancel, onSaved, skills, specialist }: Props) {
  const labels = TEXT.settings.system.specialists;
  const formId = useId();
  const [name, setName] = useState(specialist?.name ?? "");
  const [description, setDescription] = useState(specialist?.description ?? "");
  const [instructions, setInstructions] = useState(specialist?.instructions ?? "");
  const [runtime, setRuntime] = useState<RuntimeKind>(specialist?.runtime?.kind ?? "native");
  const [model, setModel] = useState(specialist?.runtime && specialist.runtime.kind !== "native" ? specialist.runtime.model ?? "" : "");
  const [skillIds, setSkillIds] = useState<string[]>([...(specialist?.enabledSkillIds ?? [])]);
  const [connectorIds, setConnectorIds] = useState<string[]>([...(specialist?.connectorIds ?? [])]);
  const [all, setAll] = useState(skillIds.length + connectorIds.length === 0);
  const [examples, setExamples] = useState<string[]>([...(specialist?.promptExamples ?? [])]);
  const [picking, setPicking] = useState<AbilityTab>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const availableSkills = selectableSkills(skills);
  const missingSkills = all ? [] : skillIds.filter(id => !availableSkills.some(skill => skill.id === id));
  const missingConnectors = all ? [] : connectorIds.filter(id => !connectors.some(connector => connector.id === id));
  const canSave = [name, description, instructions].every(value => value.trim() !== "")
    && (all || skillIds.length + connectorIds.length > 0) && missingSkills.length + missingConnectors.length === 0;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (picking !== undefined || !claimsEscape(event)) return;
      event.preventDefault();
      if (!busy) onCancel();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onCancel, picking]);
  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true); setFailure(undefined);
    try {
      const preserved = specialist?.runtime?.kind === runtime ? specialist.runtime : undefined;
      const nextRuntime: SpecialistRuntime = runtime === "native" ? { kind: "native" }
        : { ...preserved, kind: runtime, model: model.trim() || undefined } as SpecialistRuntime;
      const body: CreateSpecialistRequest = { name: name.trim(), description: description.trim(), instructions: instructions.trim(),
        connectorIds: (all ? [] : connectorIds) as CreateSpecialistRequest["connectorIds"], enabledSkillIds: all ? [] : skillIds,
        runtime: nextRuntime, promptExamples: examples.map(value => value.trim()).filter(Boolean) };
      const saved = specialist ? await updateSpecialist(client, specialist.id, body) : await createSpecialist(client, body);
      onSaved(saved);
    } catch (reason) { setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed); }
    finally { setBusy(false); }
  };
  const selectedCards = (tab: AbilityTab) => {
    const rows = tab === "skills" ? skillIds.map(id => {
      const s = skills.find(skill => skill.id === id);
      return { id, name: s?.name ?? labels.unavailableSkill(id), description: s?.loadFailure ? "" : s?.description ?? "", official: s?.source === "built-in", missing: !s || s.loadFailure !== undefined };
    }) : connectorIds.map(id => {
      const c = connectors.find(connector => connector.id === id);
      return { id, name: c?.displayName ?? c?.id ?? labels.unavailableCapability(id), description: c?.commercialUseConstraints ?? "", official: c?.trustLevel === "bundled", missing: !c };
    });
    return <details className="specialist-config-section" open>
      <summary>{tab === "skills" ? labels.skillConfiguration : labels.mcpConfiguration}{rows.length ? `（${rows.length}）` : ""}</summary>
      <button className="specialist-section-add" disabled={busy} onClick={() => setPicking(tab)} type="button">＋ {tab === "skills" ? labels.configureSkills : labels.configureMcp}</button>
      {rows.length === 0 ? <p className="specialist-empty is-inline">{labels.unconfigured}</p> : <div className="specialist-selected-grid">
        {rows.map(row => <div className={`specialist-capability-card${row.missing ? " is-missing" : ""}`} key={row.id}>
          <div className="specialist-capability-top"><SpecialistMark name={row.name} /><div><strong>{row.name}</strong><span className="specialist-badge">{row.official ? labels.builtIn : labels.external}</span></div>
            <button type="button" className="specialist-remove" disabled={busy} aria-label={`${labels.remove} ${row.id}`} onClick={() => tab === "skills" ? setSkillIds(ids => ids.filter(id => id !== row.id)) : setConnectorIds(ids => ids.filter(id => id !== row.id))}><SpecialistGlyph kind="delete" /></button>
          </div><p>{row.description}</p>
        </div>)}
      </div>}
    </details>;
  };
  return <section className="specialist-subpage" role="region" aria-label={specialist ? labels.editTitle : labels.add}>
    <div className="specialist-subpage-content">
      <button className="specialist-back" disabled={busy} type="button" onClick={onCancel}><SpecialistGlyph kind="back" />{labels.back}</button>
      <h2>{specialist ? labels.editTitle : labels.add}</h2>
      <form id={formId} className="specialist-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="specialist-field"><span>{labels.name}</span><input className="field-input" aria-label={labels.name} autoFocus={!specialist} required maxLength={80} value={name} disabled={busy} placeholder={labels.namePlaceholder} onChange={event => setName(event.target.value)} /></label>
        <label className="specialist-field"><span>{labels.description}</span><span className="specialist-input-wrap"><textarea className="field-textarea specialist-description" aria-label={labels.description} required maxLength={500} value={description} disabled={busy} placeholder={labels.descriptionPlaceholder} onChange={event => setDescription(event.target.value)} /><small>{description.length}/500</small></span></label>
        <label className="specialist-field"><span>{labels.instructions}</span><span className="specialist-input-wrap"><textarea className="field-textarea specialist-instructions" aria-label={labels.instructions} required maxLength={20_000} value={instructions} disabled={busy} placeholder={labels.instructionsHint} onChange={event => setInstructions(event.target.value)} /><small>{instructions.length}/20,000</small></span></label>
        <h3>{labels.configuration}</h3>
        <label className="specialist-field specialist-runtime"><span>{labels.runtime}</span><select aria-label={labels.runtime} disabled={busy} value={runtime} onChange={event => setRuntime(event.target.value as RuntimeKind)}>
          <option value="native">{labels.runtimeNative}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="acp">ACP</option>
        </select><small>{labels.runtimeHint}</small></label>
        {runtime !== "native" ? <label className="specialist-field specialist-runtime"><span>{labels.model}</span><input className="field-input" aria-label={labels.model} disabled={busy} value={model} placeholder={labels.modelHint} onChange={event => setModel(event.target.value)} /></label> : null}
        <div className="specialist-field"><span>{labels.capabilities}</span><div className="specialist-access" role="radiogroup" aria-label={labels.capabilities}>
          <button className={all ? "is-selected" : ""} type="button" role="radio" aria-checked={all} disabled={busy} onClick={() => setAll(true)}><strong>{labels.fullAccess} <span className="specialist-badge">{labels.defaultTag}</span></strong><span>{labels.fullAccessHint}</span></button>
          <button className={!all ? "is-selected" : ""} type="button" role="radio" aria-checked={!all} disabled={busy} onClick={() => setAll(false)}><strong>{labels.orSpecific}</strong><span>{labels.capabilitiesHint}</span></button>
        </div></div>
        {!all ? <>{selectedCards("skills")}{selectedCards("connectors")}
          {skillIds.length + connectorIds.length === 0 ? <p className="specialist-validation" role="status">{labels.selectOne}</p> : null}
          {missingSkills.length + missingConnectors.length > 0 ? <p className="specialist-validation" role="status">{labels.unavailableCapabilitiesHint}</p> : null}
        </> : null}
        <details className="specialist-config-section" open><summary>{labels.promptExamples}</summary><button type="button" className="specialist-section-add" disabled={busy || examples.length >= 10} onClick={() => setExamples(values => [...values, ""])}>＋ {labels.addExample}</button>
          {examples.length === 0 ? <p className="specialist-empty is-inline">{labels.unconfigured}</p> : examples.map((example, index) => <div className="specialist-example-field" key={index}>
            <input className="field-input" aria-label={labels.exampleNumber(index + 1)} maxLength={1000} disabled={busy} value={example} placeholder={labels.examplePlaceholder} onChange={event => setExamples(values => values.map((value, at) => at === index ? event.target.value : value))} />
            <button type="button" disabled={busy} aria-label={`${labels.remove} ${labels.exampleNumber(index + 1)}`} onClick={() => setExamples(values => values.filter((_, at) => at !== index))}>−</button>
          </div>)}
        </details>
        {failure ? <p className="specialist-feedback is-error" role="alert">{failure} <button type="button" disabled={busy} onClick={() => void save()}>{labels.retry}</button></p> : null}
      </form>
    </div>
    <footer className="specialist-editor-footer"><button type="button" className="pill-button" disabled={busy} onClick={onCancel}>{TEXT.settings.cancel}</button><button className="pill-button is-dark" type="submit" form={formId} disabled={busy || !canSave}>{busy ? labels.saving : TEXT.settings.system.save}</button></footer>
    {picking ? <AbilityPicker initialTab={picking} skills={skills} connectors={connectors} selectedSkillIds={skillIds} selectedConnectorIds={connectorIds} onClose={() => setPicking(undefined)} onApply={value => { setSkillIds(value.skillIds); setConnectorIds(value.connectorIds); setPicking(undefined); }} /> : null}
  </section>;
}
