// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type {ReactNode} from "react";
import type {EnabledSkillLibrary,RuntimeSettingsDetails,RuntimeSettingsOverrides,RuntimeSettingsField,SkillLibrary,SkillDescriptor,SkillSelectionMode} from "@sciencediscovery/schema";
type SkillMessageKey = "settings.skillModeAria" | "settings.skillModeInherit" | "common.builtIn" | "settings.managedRevision" | "settings.noSkills" | "settings.skillModeAllHint" | "settings.skillLibrariesPickerHint" | "settings.skillLibraryToggleAria" | "settings.skillLibraryHead" | "settings.skillLibraryNoVersions" | "settings.skillLibraryVersion" | "settings.skillLibraryPriority" | "settings.skillLibraryLimit" | "settings.noSkillLibraries" | "settings.skills" | "settings.skillLibraries" | "settings.skillModeAll" | "settings.skillModeSelected";
const FIELD_LABELS = {skillSelectionMode:"settings.skills",enabledSkillLibraries:"settings.skillLibraries"} as const;
const SKILL_MODE_LABELS = {all:"settings.skillModeAll",selected:"settings.skillModeSelected"} as const;
function normalizeSkillLibraryMount(mount: EnabledSkillLibrary): EnabledSkillLibrary {
  const rawLimit = Number.isFinite(mount.limit) ? mount.limit! : 12;
  const rawPriority = Number.isFinite(mount.priority) ? mount.priority! : 0;
  return {
    libraryId: mount.libraryId,
    limit: Math.min(Math.max(Math.round(rawLimit), 1), 100),
    priority: Math.min(Math.max(Math.round(rawPriority), -1_000_000), 1_000_000),
    versionId: mount.versionId?.trim() || "head",
  };
}

export function normalizeSkillLibraryMounts(mounts: readonly EnabledSkillLibrary[] = [], libraries: readonly SkillLibrary[] = []): EnabledSkillLibrary[] {
  const byId = new Map(mounts.map((mount) => [mount.libraryId, normalizeSkillLibraryMount(mount)]));
  const ordered = libraries
    .map((library) => byId.get(library.id))
    .filter((mount): mount is EnabledSkillLibrary => Boolean(mount));
  const knownIds = new Set(libraries.map((library) => library.id));
  ordered.push(...[...byId.values()].filter((mount) => !knownIds.has(mount.libraryId)));
  return ordered;
}


export function SkillSettingsSection({details,draft,setDraft,skillLibraries,skills,skillScope,disabled,t,renderSource}:{
details:RuntimeSettingsDetails;draft:RuntimeSettingsOverrides;setDraft:(update:(value:RuntimeSettingsOverrides)=>RuntimeSettingsOverrides)=>void;
skillLibraries:SkillLibrary[];skills:SkillDescriptor[];skillScope:"global"|"project"|"session";disabled:boolean;
t:(key:SkillMessageKey,variables?:Record<string,string|number>)=>string;renderSource:(field:RuntimeSettingsField)=>ReactNode;
}) {
 const saving=false;
  /** `inherit` drops both skill fields; `all` needs no whitelist to be stored. */
  function setSkillMode(value: "inherit" | SkillSelectionMode): void {
    setDraft((current) => {
      const next = { ...current };
      delete next.enabledSkillIds;
      if (value === "inherit") delete next.skillSelectionMode;
      else if (value === "all") next.skillSelectionMode = "all";
      else {
        next.skillSelectionMode = "selected";
        next.enabledSkillIds = current.enabledSkillIds ?? [];
      }
      return next;
    });
  }

  function toggleArrayValue(field: "enabledConnectorIds" | "enabledSkillIds", value: string): void {
    setDraft((current) => {
      const selected = current[field] ?? [];
      const nextValues = selected.includes(value as never)
        ? selected.filter((item) => item !== value)
        : [...selected, value] as never[];
      return { ...current, [field]: nextValues };
    });
  }

  function setSkillLibraryMount(libraryId: string, patch: Partial<EnabledSkillLibrary>): void {
    setDraft((current) => {
      const mounts = normalizeSkillLibraryMounts(current.enabledSkillLibraries ?? skillLibraryMounts, skillLibraries);
      const index = mounts.findIndex((mount) => mount.libraryId === libraryId);
      if (index < 0) return current;
      mounts[index] = normalizeSkillLibraryMount({ ...mounts[index]!, ...patch });
      return { ...current, enabledSkillLibraries: mounts };
    });
  }

  function toggleSkillLibrary(library: SkillLibrary): void {
    setDraft((current) => {
      const mounts = normalizeSkillLibraryMounts(current.enabledSkillLibraries ?? skillLibraryMounts, skillLibraries);
      const selected = mounts.some((mount) => mount.libraryId === library.id);
      return {
        ...current,
        enabledSkillLibraries: selected
          ? mounts.filter((mount) => mount.libraryId !== library.id)
          : [...mounts, normalizeSkillLibraryMount({ libraryId: library.id })],
      };
    });
  }


  const skillInheritable = skillScope === "session";
  // Project is the root skill layer, so an unset mode there simply means `all`.
  const skillMode: "inherit" | SkillSelectionMode = draft.skillSelectionMode
    ?? (skillInheritable ? "inherit" : "all");
  const skillWhitelist = skillMode === "selected";
  const rawSkillLibraryMounts = draft.enabledSkillLibraries ?? details.effective.enabledSkillLibraries;
  const skillLibraryMounts = normalizeSkillLibraryMounts(rawSkillLibraryMounts, skillLibraries);
  const skillLibraryMountsById = new Map(skillLibraryMounts.map((mount) => [mount.libraryId, normalizeSkillLibraryMount(mount)]));

 return <>      {skillScope === "global" ? null : <fieldset className="settings-array" disabled={disabled || saving}>
        <legend>{t(FIELD_LABELS.skillSelectionMode)}</legend>
        <select aria-label={t("settings.skillModeAria")} value={skillMode} onChange={(event) => setSkillMode(event.target.value as "inherit" | SkillSelectionMode)}>
          {skillInheritable ? <option value="inherit">
            {t("settings.skillModeInherit", { mode: t(SKILL_MODE_LABELS[details.effective.skillSelectionMode]), count: details.effective.enabledSkillIds.length })}
          </option> : null}
          <option value="all">{t(SKILL_MODE_LABELS.all)}</option>
          <option value="selected">{t(SKILL_MODE_LABELS.selected)}</option>
        </select>
        {skillWhitelist ? <div className="settings-choices">
          {skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={draft.enabledSkillIds?.includes(skill.id) ?? false} onChange={() => toggleArrayValue("enabledSkillIds", skill.id)} /><span>{skill.name}<small>{skill.source === "built-in" ? t("common.builtIn") : t("settings.managedRevision", { revision: skill.currentRevision })}</small></span></label>)}
          {!skills.length ? <p className="settings-choice-empty">{t("settings.noSkills")}</p> : null}
        </div> : <small className="settings-hint">{t("settings.skillModeAllHint")}</small>}
        {skillInheritable ? renderSource("skillSelectionMode") : null}
      </fieldset>}

      {skillScope === "global" ? null : <fieldset className="settings-array" disabled={disabled || saving}>
        <legend>{t(FIELD_LABELS.enabledSkillLibraries)}</legend>
        <small className="settings-hint">{t("settings.skillLibrariesPickerHint" as SkillMessageKey)}</small>
        <div className="settings-library-list">
          {skillLibraries.map((library) => {
            const mount = skillLibraryMountsById.get(library.id);
            const selected = Boolean(mount);
            const selectedMount = mount ?? normalizeSkillLibraryMount({ libraryId: library.id });
            return <div className={selected ? "settings-library-row selected" : "settings-library-row"} key={library.id}>
              <label className="settings-library-picker">
                <input
                  aria-label={t("settings.skillLibraryToggleAria" as SkillMessageKey, { name: library.name })}
                  checked={selected}
                  disabled={!library.headVersionId && !selected}
                  onChange={() => toggleSkillLibrary(library)}
                  type="checkbox"
                />
                <span className="settings-library-main">
                  <strong>{library.name}</strong>
                  <small>{library.headVersionId ? t("settings.skillLibraryHead" as SkillMessageKey, { version: library.headVersionId.slice(0, 8) }) : t("settings.skillLibraryNoVersions" as SkillMessageKey)}</small>
                </span>
              </label>
              {selected ? <div className="settings-library-controls">
                <label><span>{t("settings.skillLibraryVersion" as SkillMessageKey)}</span><input value={selectedMount.versionId ?? "head"} onChange={(event) => setSkillLibraryMount(library.id, { versionId: event.target.value || "head" })} placeholder="head" /></label>
                <label><span>{t("settings.skillLibraryPriority" as SkillMessageKey)}</span><input inputMode="numeric" type="number" value={selectedMount.priority ?? 0} onChange={(event) => setSkillLibraryMount(library.id, { priority: Number(event.target.value || 0) })} /></label>
                <label><span>{t("settings.skillLibraryLimit" as SkillMessageKey)}</span><input inputMode="numeric" max={100} min={1} type="number" value={selectedMount.limit ?? 12} onChange={(event) => setSkillLibraryMount(library.id, { limit: Number(event.target.value || 12) })} /></label>
              </div> : null}
            </div>;
          })}
          {!skillLibraries.length ? <p className="settings-choice-empty">{t("settings.noSkillLibraries" as SkillMessageKey)}</p> : null}
        </div>
        {renderSource("enabledSkillLibraries")}
      </fieldset>}
</>;
}
