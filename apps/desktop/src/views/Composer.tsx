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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { listSkills, listSpecialists } from "../api/settings.js";
import type {
  ApprovalMode,
  ModelProfile,
  ModelProvider,
  Project,
  SkillDescriptor,
  Specialist,
} from "../api/types.js";
import type { Attachment } from "../app/attachments.js";
import { commitsOnEnter } from "../app/ime-enter.js";
import type { LandingCategory, LandingSeed } from "../app/landing.js";
import { skillChoices, skillDraft, skillMark, slashQuery } from "../app/slash.js";
import { TEXT } from "../text.js";
import { AttachmentTray } from "./AttachmentTray.js";
import { EvolveGlyph, EvolveTreeGlyph } from "./evolve/glyphs.js";
import { filterExperts } from "./expert-catalog.js";
import { modelBrand } from "./model-brand.js";
import { modelLabel, providerName } from "./provider-name.js";
import { ProjectPicker } from "./ProjectPicker.js";

/** The category chip the welcome page puts in front of the input. */
export interface ComposerTag {
  kind: LandingCategory;
  label: string;
  onClear: () => void;
}

/** A command a setup dialog placed in the input.
 *
 *  The flags are not prose: a user who edits `/evolve-design --algorithm
 *  puct` by hand can break the one word the agent reads. So the dialog's
 *  output is drawn as a token at the start of the input, and the sentence it
 *  collected becomes the first draft after it. Both leave together, joined at
 *  submit time — until then the token is part of the input, not a message. */
export interface SeededCommand {
  /** The flags, exactly as they will be sent. */
  command: string;
  /** Bumped on every seed, so choosing the same design twice still lands. */
  nonce: number;
  /** What the dialog collected, written after the token for the user to
   *  finish or replace. */
  text: string;
}

interface Props {
  approvalMode?: ApprovalMode;
  /** The Project the next conversation would go into, for the landing strip's
   *  picker to mark. Undefined until the boot knows which Projects exist. */
  activeProjectId?: string;
  /** Why uploading is not on offer, or `undefined` when it is. A reason rather
   *  than a flag because the button's tooltip has to say what is missing. */
  attachBlocked?: string;
  /** Reads the expert catalog for 专家's flyout. Absent in a static render,
   *  where the flyout is never opened and there is nothing to fetch. */
  client?: ApiClient;
  /** The per-file ceiling to state in that tooltip, already formatted. */
  attachLimit?: string;
  /** The files this turn already holds, shown above the input. */
  attachments: readonly Attachment[];
  /** Why chat is gated, or `undefined` when it is not — the shell reports the
   *  JiuwenSwarm cluster is still starting. A reason rather than a flag so
   *  the placeholder can say what is being waited on. */
  jwBlocked?: string;
  /** The welcome page's arrangement: the card floats, and a grey strip under
   *  it carries the project and the permission mode. */
  landing?: boolean;
  models: ModelProfile[];
  onApprovalMode: (mode: ApprovalMode) => void;
  /** 新建项目 from the landing strip: a Project needs nothing but a name. */
  onCreateProject: (name: string) => void;
  /** Opens the session's searches, or starts a new experiment when it has
   *  none. It is a row in 会话设置 rather than a control of its own: the
   *  header no longer carries a second entry point. */
  onEvolve?: () => void;
  onOpenSettings: () => void;
  /** A skill whose choice has more to it than its command: the pick is handed
   *  here, and `true` means the surface it opened has taken the draft, so no
   *  command is written. */
  onPickSkill?: (skill: SkillDescriptor) => boolean;
  onSelectModel: (modelId: string) => void;
  /** Point the next conversation at a Project, or at none (`undefined`). */
  onSelectProject: (projectId?: string) => void;
  /** Binds an expert to the session, or clears the binding. */
  onSelectSpecialist?: (specialistId?: string) => void;
  /** Empty the attachment tray. */
  onClearAttachments: () => void;
  /** Take one attachment out of the tray. */
  onRemoveAttachment: (id: string) => void;
  /** Upload a failed attachment again. */
  onRetryAttachment: (id: string) => void;
  /** `command` is the seeded token when the draft started from a setup
   *  dialog; the two are one message, but only the caller knows how to join
   *  them. */
  onSend: (content: string, command?: string) => void;
  onStop: () => void;
  onUpload: (files: File[]) => void;
  /** Shown in the landing strip, beside the folder. Absent when the next
   *  conversation goes into no Project: the strip then shows the picker's
   *  invitation in place of a name. */
  projectName?: string;
  /** The Projects the landing strip's picker offers; the inbox is not one. */
  projects: Project[];
  /** Where the model menu gets each row's brand mark. A profile names its
   *  provider, and the provider knows its preset. */
  providers?: ModelProvider[];
  running: boolean;
  /** A starter prompt chosen on the welcome page, to be placed in the input. */
  seed?: LandingSeed;
  /** A design command a setup dialog placed here, drawn as a token before the
   *  input. Distinct from `seed`: the token is sent with the draft. */
  seededCommand?: SeededCommand;
  selectedModelId?: string;
  /** The expert the open session is bound to, if any. */
  selectedSpecialistId?: string;
  /** The category the welcome page attached to this turn. */
  tag?: ComposerTag;
  uploading: boolean;
}

type Menu = "model" | "settings";

function PlusGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="17">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** The sliders beside the plus: the session's own settings, not the app's. */
function SlidersGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="17">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.1" />
      <circle cx="9" cy="17" r="2.1" />
    </svg>
  );
}

type SettingsPanel = "experts" | "permission";

/** The shield that marks permission, and its warning form for 完全访问. */
function ShieldGlyph({ alert = false }: { alert?: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="18">
      <path d="M12 3.4 5.2 6.4v5.1c0 4.2 2.8 7.1 6.8 8.7 4-1.6 6.8-4.5 6.8-8.7V6.4z" />
      {alert ? (
        <>
          <path d="M12 8.7v3.4" />
          <path d="M12 15.6h.01" />
        </>
      ) : (
        <path d="M12 9.2v3.1" />
      )}
    </svg>
  );
}

/** The person that marks 专家. */
function PersonGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="18">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19.4c.7-3.2 3.4-5.2 6.6-5.2s5.9 2 6.6 5.2" />
    </svg>
  );
}

/** The tick against the chosen option in a flyout. */
function CheckGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="15">
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

/** The ✕ that detaches the category chip from the turn. */
function CloseGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" viewBox="0 0 24 24" width="11">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function ChevronRightGlyph() {
  return (
    <svg aria-hidden="true" className="session-menu-chev" fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** The dash in a quiet square: 专家's "none" option. */
function NoneGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * 权限模式's choices, beside the row that opened them.
 *
 * Each option says under its name what it allows. That sentence used to be a
 * `title`, which only a mouse reaches — for the one switch that widens what
 * the session can touch, the consequence has to be text on screen and a
 * description a screen reader reads.
 *
 * Exported because it is only mounted while its row is open.
 */
export function PermissionFlyout({
  fullAccess,
  onApprovalMode,
  onClose,
}: {
  fullAccess: boolean;
  onApprovalMode: (mode: ApprovalMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="session-menu-flyout">
      <button
        aria-describedby="session-permission-ask-desc"
        aria-label={TEXT.composer.permission}
        className={`session-flyout-row${fullAccess ? "" : " is-selected"}`}
        onClick={() => {
          onApprovalMode("ask_for_dangerous");
          onClose();
        }}
        type="button"
      >
        <span className="session-flyout-icon">
          <ShieldGlyph />
        </span>
        <span className="session-flyout-text">
          <span className="session-flyout-label">{TEXT.composer.permission}</span>
          <span className="session-flyout-desc" id="session-permission-ask-desc">
            {TEXT.composer.permissionAskDesc}
          </span>
        </span>
        {fullAccess ? null : (
          <span className="session-flyout-check">
            <CheckGlyph />
          </span>
        )}
      </button>
      <button
        aria-describedby="session-permission-full-desc"
        aria-label={TEXT.composer.permissionFull}
        className={`session-flyout-row is-danger${fullAccess ? " is-selected" : ""}`}
        onClick={() => {
          onApprovalMode("always_allow");
          onClose();
        }}
        type="button"
      >
        <span className="session-flyout-icon">
          <ShieldGlyph alert />
        </span>
        <span className="session-flyout-text">
          <span className="session-flyout-label">{TEXT.composer.permissionFull}</span>
          <span className="session-flyout-desc" id="session-permission-full-desc">
            {TEXT.composer.permissionFullDesc}
          </span>
        </span>
        {fullAccess ? (
          <span className="session-flyout-check">
            <CheckGlyph />
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * 会话设置, behind the sliders beside the plus: a column of the session's own
 * rows and, beside the open one, its choices. The two columns are separate
 * cards so a flyout is never clipped by the row column's own scroll box.
 *
 * Exported because it is only mounted while open, and a static render of the
 * composer never gets there.
 */
export function SessionSettingsMenu({
  approvalMode,
  experts,
  expertsLoading,
  onApprovalMode,
  onClose,
  onEvolve,
  onSelectSpecialist,
  running,
  selectedSpecialistId,
}: {
  approvalMode?: ApprovalMode;
  /** The experts a session can be bound to, already read by the composer.
   *  Held there rather than here so reopening the menu does not blank the row
   *  above it back to 无 while the catalog is fetched again. */
  experts?: Specialist[];
  expertsLoading?: boolean;
  onApprovalMode: (mode: ApprovalMode) => void;
  onClose: () => void;
  /** Opens the evolve surface. Absent in a static render, where the entry has
   *  nowhere to go. */
  onEvolve?: () => void;
  onSelectSpecialist?: (specialistId?: string) => void;
  running: boolean;
  selectedSpecialistId?: string;
}) {
  const [panel, setPanel] = useState<SettingsPanel>();
  const fullAccess = approvalMode === "always_allow";
  const selectedExpert = (experts ?? []).find((row) => row.id === selectedSpecialistId);
  const toggle = (next: SettingsPanel) => setPanel((current) => (current === next ? undefined : next));

  return (
    <div className="composer-dropdown is-settings" onPointerDown={(event) => event.stopPropagation()}>
      <div className="session-menu">
        <div className="session-menu-panel">
          {/* An action rather than a setting: it opens a surface instead of
              showing a value, so it carries no value capsule or chevron. It
              sits first, the way the handoff orders this menu. */}
          {onEvolve === undefined ? null : (
            <>
              <button
                className="session-menu-row"
                onClick={() => {
                  onClose();
                  onEvolve();
                }}
                type="button"
              >
                <span className="session-menu-icon">
                  <EvolveGlyph size={18} />
                </span>
                <span className="session-menu-label">{TEXT.composer.evolveExperiment}</span>
              </button>
              <div className="session-menu-divider" />
            </>
          )}
          <button
            aria-expanded={panel === "permission"}
            aria-haspopup="true"
            className={`session-menu-row${panel === "permission" ? " is-open" : ""}`}
            disabled={running}
            onClick={() => toggle("permission")}
            title={running ? TEXT.composer.permissionLocked : undefined}
            type="button"
          >
            <span className="session-menu-icon">
              <ShieldGlyph />
            </span>
            <span className="session-menu-label">{TEXT.composer.permissionMode}</span>
            <span className="session-menu-value">
              <span className="session-menu-value-icon">
                <ShieldGlyph />
              </span>
              <span className="session-menu-value-text">
                {fullAccess ? TEXT.composer.permissionFull : TEXT.composer.permissionAskShort}
              </span>
              <ChevronRightGlyph />
            </span>
          </button>
          <div className="session-menu-divider" />
          <button
            aria-describedby="session-experts-hint"
            aria-expanded={panel === "experts"}
            aria-haspopup="true"
            className={`session-menu-row${panel === "experts" ? " is-open" : ""}`}
            onClick={() => toggle("experts")}
            type="button"
          >
            <span className="session-menu-icon">
              <PersonGlyph />
            </span>
            <span className="session-menu-label">{TEXT.composer.experts}</span>
            <span className="session-menu-value">
              <span className="session-menu-value-text">
                {selectedExpert?.name ?? TEXT.composer.expertsNone}
              </span>
              <ChevronRightGlyph />
            </span>
            {/* The row's explanation, shown over it on hover. It is aria-hidden
                because a tooltip inside the button would otherwise be read as
                part of the row's name; the hidden sentence below carries the
                same words to assistive technology. */}
            <span aria-hidden="true" className="session-menu-tip">
              {TEXT.composer.expertsHint}
            </span>
          </button>
          <span className="sr-only" id="session-experts-hint">{TEXT.composer.expertsHint}</span>
        </div>

        {panel === "permission" ? (
          <PermissionFlyout fullAccess={fullAccess} onApprovalMode={onApprovalMode} onClose={onClose} />
        ) : null}

        {panel === "experts" ? (
          <ExpertFlyout
            loading={expertsLoading ?? false}
            onClose={onClose}
            onSelect={(specialistId) => {
              onSelectSpecialist?.(specialistId);
              onClose();
            }}
            selectedId={selectedSpecialistId}
            specialists={experts ?? []}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The magnifier at the start of 专家's search field. */
function SearchGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="15">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

/** The colours an expert's initial can take. They carry nothing — the list is
 *  ordered and filtered — they only make one row easier to find again. */
const EXPERT_TONES = ["is-blue", "is-pink", "is-amber", "is-violet", "is-teal"] as const;

function expertTone(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 997;
  return EXPERT_TONES[hash % EXPERT_TONES.length] ?? "is-blue";
}

/**
 * Put focus and the caret at the end of a draft that was just filled in — on
 * the next frame, after React has painted the new text into the field — and
 * return the cancel an effect hands back. Both a starter prompt and a design's
 * command land in the input rather than sending immediately, so the reader is
 * meant to keep typing after them.
 */
function focusAtEnd(node: HTMLTextAreaElement): () => void {
  const frame = window.requestAnimationFrame(() => {
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  });
  return () => window.cancelAnimationFrame(frame);
}


/**
 * 专家's choices: the experts this app can bind to a session.
 *
 * The reference lists them the way a catalog does — a search line, then one
 * row per expert with its initial and its one-line description — rather than
 * as a menu of names. 无 keeps its place at the top of the list: it is how a
 * binding is undone.
 *
 * Exported because it is only mounted while its row is open.
 */
export function ExpertFlyout({
  loading,
  onClose,
  onSelect,
  selectedId,
  specialists,
}: {
  loading: boolean;
  onClose: () => void;
  onSelect: (specialistId?: string) => void;
  selectedId?: string;
  specialists: Specialist[];
}) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const shown = filterExperts(specialists, query);

  // The list can be longer than the card; opening it on the bound expert is
  // what shows the reader where the session stands, without hunting for the
  // tick.
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div className="session-menu-flyout is-experts">
      <label className="expert-search">
        <SearchGlyph />
        <input
          aria-label={TEXT.composer.expertsSearch}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={TEXT.composer.expertsSearch}
          type="search"
          value={query}
        />
      </label>
      <div className="session-menu-divider" />
      <div className="expert-list" ref={list}>
        <button
          aria-current={selectedId === undefined ? "true" : undefined}
          className={`expert-row${selectedId === undefined ? " is-selected" : ""}`}
          onClick={() => onSelect(undefined)}
          type="button"
        >
          <span className="expert-mark is-none">
            <NoneGlyph />
          </span>
          <span className="expert-text">
            <span className="expert-name">{TEXT.composer.expertsNone}</span>
          </span>
          {selectedId === undefined ? (
            <span className="session-flyout-check">
              <CheckGlyph />
            </span>
          ) : null}
        </button>
        {shown.map((specialist) => {
          const selected = specialist.id === selectedId;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={`expert-row${selected ? " is-selected" : ""}`}
              key={specialist.id}
              onClick={() => onSelect(specialist.id)}
              type="button"
            >
              <span className={`expert-mark ${expertTone(specialist.id)}`}>
                {specialist.name.slice(0, 1)}
              </span>
              <span className="expert-text">
                <span className="expert-name">{specialist.name}</span>
                {specialist.description === "" ? null : (
                  <span className="expert-desc">{specialist.description}</span>
                )}
              </span>
              {selected ? (
                <span className="session-flyout-check">
                  <CheckGlyph />
                </span>
              ) : null}
            </button>
          );
        })}
        {loading && shown.length === 0 ? (
          <p className="expert-note">{TEXT.composer.expertsLoading}</p>
        ) : null}
        {!loading && shown.length === 0 ? (
          <p className="expert-note">{TEXT.composer.expertsEmpty}</p>
        ) : null}
      </div>
    </div>
  );
}

function Chevron({ down = true }: { down?: boolean }) {
  return (
    <svg
      className="model-chev"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      style={down ? undefined : { transform: "rotate(180deg)" }}
      viewBox="0 0 24 24"
      width="12"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/**
 * The model menu's contents: the models, a hairline, and the way to add one.
 *
 * One row per model, each row a single line — the provider is its icon, so the
 * words only have to say which model. Exported because the menu only exists
 * while it is open, and the rows are the part worth testing.
 */
export function ModelMenu({
  models,
  onAdd,
  onSelect,
  providers = [],
  selectedId,
}: {
  models: ModelProfile[];
  onAdd: () => void;
  onSelect: (modelId: string) => void;
  providers?: ModelProvider[];
  selectedId?: string;
}) {
  const list = useRef<HTMLDivElement>(null);

  // With more models than the list can show, the one in use may start below
  // the fold. Put it in view without moving the card.
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <>
      <div className="model-menu-list" ref={list}>
        {models.map((model) => {
          const name = providerName(model.name);
          const current = model.id === selectedId;
          return (
            <button
              aria-current={current ? "true" : undefined}
              className="model-option"
              key={model.id}
              onClick={() => onSelect(model.id)}
              title={name}
              type="button"
            >
              <span
                aria-hidden="true"
                className="model-option-icon"
                data-brand={modelBrand(model, providers)}
              />
              <span className="model-option-label">{modelLabel(name)}</span>
              {current ? (
                <span className="model-option-check">
                  <CheckGlyph />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="model-menu-divider" />
      <button className="model-option is-add" onClick={onAdd} type="button">
        <span aria-hidden="true" className="model-option-plus">
          <PlusGlyph />
        </span>
        <span className="model-option-label">{TEXT.composer.addCustomModel}</span>
      </button>
    </>
  );
}

/**
 * The composer, as the handoff draws it: one rounded card, the input over a
 * footer of 上传, 会话设置, the model and 发送.
 *
 * The plus does one thing — it opens the file picker, because uploading is the
 * only way of giving the turn more than text this service carries. Permission
 * and 专家 live behind the sliders beside it, the way the reference groups a
 * session's own settings.
 */
export function Composer({
  activeProjectId,
  approvalMode,
  attachBlocked,
  attachLimit,
  attachments,
  jwBlocked,
  client,
  landing = false,
  models,
  onApprovalMode,
  onClearAttachments,
  onCreateProject,
  onEvolve,
  onOpenSettings,
  onPickSkill,
  onRemoveAttachment,
  onRetryAttachment,
  onSelectModel,
  onSelectProject,
  onSelectSpecialist,
  onSend,
  onStop,
  onUpload,
  projectName,
  projects,
  providers = [],
  running,
  seed,
  seededCommand,
  selectedModelId,
  selectedSpecialistId,
  tag,
  uploading,
}: Props) {
  const [text, setText] = useState(seededCommand?.text ?? "");
  /** The dialog's flags, kept apart from the sentence so the token cannot be
   *  edited into something the agent no longer understands. Seeded in the
   *  initial state as well as in the effect below, so a composer mounted with
   *  a token already in hand draws it on the first frame. */
  const [command, setCommand] = useState<string | undefined>(seededCommand?.command);
  const [menu, setMenu] = useState<Menu>();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** The input row and the command token inside it, measured together: the
   *  token sits on the first line only and the field is indented by its width,
   *  so both numbers have to come from the actual layout. */
  const row = useRef<HTMLDivElement>(null);
  const token = useRef<HTMLSpanElement>(null);

  /** 专家's catalog. Read once per client, not per menu opening: the row's
   *  value is the bound expert's name, and reopening the menu must not show 无
   *  for the half second a fresh fetch takes. A disabled expert cannot be
   *  bound — the server drops it — so it is not listed here. */
  const [experts, setExperts] = useState<Specialist[]>([]);
  const [expertsLoading, setExpertsLoading] = useState(false);
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    setExpertsLoading(true);
    void listSpecialists(client)
      .then((rows) => {
        if (!cancelled) setExperts(rows.filter((row) => row.enabled !== false));
      })
      .catch(() => {
        if (!cancelled) setExperts([]);
      })
      .finally(() => {
        if (!cancelled) setExpertsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  /** The skills `/` can offer. Read once with the experts: both are small
   *  catalogs, and the palette has to have something to draw the moment the
   *  slash is typed. */
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    void listSkills(client)
      .then((rows) => {
        if (!cancelled) setSkills(rows);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // The palette is derived from the draft rather than opened by a key: it is
  // showing exactly while the draft is one `/` command (see `slashQuery`), so
  // typing the space that starts the request closes it without any state to
  // keep in step. Only the highlighted row and an explicit Escape are state.
  const query = slashQuery(text);
  const choices = query === undefined ? [] : skillChoices(skills, query);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setHighlight(0), [query]);
  useEffect(() => setDismissed(false), [query]);
  const open = choices.length > 0 && !dismissed;
  const active = Math.min(highlight, Math.max(choices.length - 1, 0));

  const pickSkill = (skill: SkillDescriptor) => {
    // A skill with a setup surface of its own takes the pick: its command
    // carries flags the dialog asks for, so writing the bare command would
    // only be a step towards opening that dialog anyway. The draft is emptied
    // because the slash was the whole of it.
    if (onPickSkill?.(skill) === true) {
      setText("");
      setDismissed(true);
      return;
    }
    setText(skillDraft(skill));
    setDismissed(true);
    const node = area.current;
    if (!node) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  };

  const selected = models.find((model) => model.id === selectedModelId) ?? models[0];
  /** The stored name is the server's; the pill shows it in the interface's
   *  language. */
  const selectedName = selected ? providerName(selected.name) : undefined;
  const canSend = text.trim() !== "" && !running && jwBlocked === undefined;

  // Grow with the content up to the CSS max-height, then scroll. Done by hand
  // because a textarea cannot size to its content.
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
    // Growing or shrinking the field resets its scroll, and the token rides on
    // that scroll (see the layout effect below).
    row.current?.style.setProperty("--composer-command-shift", `${-node.scrollTop}px`);
  }, [text]);

  // The command token is drawn out of flow at the start of the first line, and
  // the field's first line is indented past it. As a flex sibling the token
  // would push the whole paragraph right, leaving a blank gutter under it on
  // every wrapped line. Both numbers are measured rather than fixed: the
  // token's width depends on the language, the loaded font, and whether a
  // category chip sits in front of it.
  useLayoutEffect(() => {
    const box = row.current;
    if (box === null) return;
    let live = true;
    const measure = () => {
      const pill = token.current;
      const field = area.current;
      if (!live || pill === null || field === null) {
        box.style.removeProperty("--composer-command-left");
        box.style.removeProperty("--composer-command-indent");
        return;
      }
      // The token starts where the field's text starts: with the token out of
      // flow, the field is the first thing in the row (after any category
      // chip, which is why this is measured and not a constant).
      const left = field.getBoundingClientRect().left - box.getBoundingClientRect().left;
      box.style.setProperty("--composer-command-left", `${left}px`);
      box.style.setProperty("--composer-command-indent", `${pill.getBoundingClientRect().width + 8}px`);
    };
    measure();
    // A font finishing its load changes the token's width without a render.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (observer !== undefined && token.current !== null) observer.observe(token.current);
    void document.fonts?.ready.then(measure).catch(() => undefined);
    window.addEventListener("resize", measure);
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [command, tag]);

  // A starter prompt from the welcome page replaces whatever the input holds:
  // it is a deliberate choice, not text inserted at the caret. The cursor goes
  // to the end so the reader can keep typing from where the prompt stops.
  useEffect(() => {
    if (seed === undefined) return;
    setText(seed.text);
    const node = area.current;
    if (!node) return;
    return focusAtEnd(node);
  }, [seed]);

  // A design's command lands here as a token, with the dialog's goal after it
  // and the caret at the end: the next keystroke continues the sentence, which
  // is the whole point of placing it in the input instead of sending it.
  useEffect(() => {
    if (seededCommand === undefined) return;
    setCommand(seededCommand.command);
    setText(seededCommand.text);
    const node = area.current;
    if (!node) return;
    return focusAtEnd(node);
  }, [seededCommand]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(undefined);
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  const submit = () => {
    if (!canSend) return;
    onSend(text, command);
    setText("");
    setCommand(undefined);
  };

  const chooseFiles = () => {
    if (attachBlocked !== undefined || uploading) return;
    setMenu(undefined);
    picker.current?.click();
  };

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <div
      className={`composer${landing ? " is-landing" : ""}${attachments.length > 0 ? " has-attachments" : ""}`}
      data-guide="composer"
    >
      {open ? (
        <div aria-label={TEXT.composer.skillsPalette} className="composer-skills" role="listbox">
          {choices.map((skill, index) => (
            <button
              aria-selected={index === active}
              className={`expert-row${index === active ? " is-selected" : ""}`}
              key={skill.id}
              onMouseDown={(event) => {
                // The press would otherwise move the caret out of the draft
                // before the click lands, and choosing a skill is a write to
                // that draft.
                event.preventDefault();
                pickSkill(skill);
              }}
              role="option"
              type="button"
            >
              <span className="expert-mark is-skill" aria-hidden="true">{skillMark(skill)}</span>
              <span className="expert-text">
                <span className="expert-name">{skill.name}</span>
                {skill.description === "" ? null : (
                  <span className="expert-desc">{skill.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <AttachmentTray
          attachments={attachments}
          onClear={onClearAttachments}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
        />
      ) : null}
      <div className="composer-input" ref={row}>
        {tag ? (
          <span className="composer-tag">
            <span aria-hidden="true" className="composer-tag-icon" data-kind={tag.kind} />
            <span className="composer-tag-label">{tag.label}</span>
            <button
              aria-label={TEXT.landing.clearCategory}
              className="composer-tag-clear"
              onClick={tag.onClear}
              type="button"
            >
              <CloseGlyph />
            </button>
          </span>
        ) : null}
        {/* The design's flags, before the sentence they belong to: one token,
            in the accent colour, so it reads as something the app placed here
            rather than text the user has to keep intact. */}
        {command === undefined ? null : <span className="composer-command" ref={token} title={command}>
          <EvolveTreeGlyph size={13} />
          <span className="composer-command-text">{command}</span>
        </span>}
        <textarea
          disabled={running || jwBlocked !== undefined}
          id="composer-textarea"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // The palette claims the keys it navigates with before the
            // composer reads Enter as send — but only while it is showing
            // rows, so a draft with no matching skill still sends.
            if (open) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((current) => (current + 1) % choices.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((current) => (current - 1 + choices.length) % choices.length);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(true);
                return;
              }
              if (event.key === "Tab" || (commitsOnEnter(event) && !event.shiftKey)) {
                event.preventDefault();
                const choice = choices[active];
                if (choice !== undefined) pickSkill(choice);
                return;
              }
            }
            if (commitsOnEnter(event) && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          onScroll={(event) => {
            // The token is out of flow, so it does not scroll with the text on
            // its own; past the max-height it would sit over the lines that
            // scrolled under it. It moves by the field's own offset instead.
            row.current?.style.setProperty(
              "--composer-command-shift",
              `${-event.currentTarget.scrollTop}px`,
            );
          }}
          placeholder={jwBlocked ?? (command !== undefined ? TEXT.composer.evolvePlaceholder
            : landing ? TEXT.landing.placeholder : TEXT.composer.placeholder)}
          ref={area}
          rows={1}
          value={text}
        />
      </div>
      <div className="composer-footer">
        <button
          aria-label={TEXT.composer.uploadFile}
          className="composer-plus"
          disabled={attachBlocked !== undefined || uploading}
          onClick={chooseFiles}
          title={attachBlocked ?? TEXT.composer.attachHint(attachLimit)}
          type="button"
        >
          {uploading ? <span className="spinner" /> : <PlusGlyph />}
        </button>

        <span className="composer-menu-anchor is-settings">
          <button
            aria-expanded={menu === "settings"}
            aria-label={TEXT.composer.sessionSettings}
            className="composer-plus composer-settings"
            onClick={(event) => {
              event.stopPropagation();
              setMenu(menu === "settings" ? undefined : "settings");
            }}
            title={TEXT.composer.sessionSettings}
            type="button"
          >
            <SlidersGlyph />
          </button>
          {menu === "settings" ? (
            <SessionSettingsMenu
              approvalMode={approvalMode}
              experts={experts}
              expertsLoading={expertsLoading}
              onApprovalMode={onApprovalMode}
              onClose={() => setMenu(undefined)}
              onEvolve={onEvolve}
              onSelectSpecialist={onSelectSpecialist}
              running={running}
              selectedSpecialistId={selectedSpecialistId}
            />
          ) : null}
        </span>

        <input
          className="composer-file-input"
          multiple
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            // Cleared so that choosing the same file twice in a row still
            // fires a change event: the input's value would otherwise be
            // unchanged and the browser would swallow the second selection.
            event.target.value = "";
            if (chosen.length > 0) onUpload(chosen);
          }}
          ref={picker}
          type="file"
        />

        <span className="composer-spacer" />

        <span className="composer-menu-anchor is-model">
          <button
            aria-expanded={menu === "model"}
            aria-label={TEXT.composer.modelSelect}
            className="composer-model-pill"
            onClick={(event) => {
              event.stopPropagation();
              if (running) return;
              setMenu(menu === "model" ? undefined : "model");
            }}
            title={running ? TEXT.composer.pillLocked : TEXT.composer.modelSelect}
            type="button"
          >
            <span className="model-name">
              {selectedName ?? TEXT.errors.modelRequired}
            </span>
            <Chevron down={menu !== "model"} />
          </button>
          {menu === "model" ? (
            <div className="composer-dropdown is-models" onPointerDown={stop}>
              <ModelMenu
                models={models}
                onAdd={() => {
                  setMenu(undefined);
                  onOpenSettings();
                }}
                onSelect={(modelId) => {
                  setMenu(undefined);
                  onSelectModel(modelId);
                }}
                providers={providers}
                selectedId={selected?.id}
              />
            </div>
          ) : null}
        </span>

        {running ? (
          <button
            aria-label={TEXT.composer.stop}
            className="send-button-icon"
            onClick={onStop}
            title={TEXT.composer.stopHint}
            type="button"
          >
            <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
              <rect fill="currentColor" height="10" rx="2" width="10" x="7" y="7" />
            </svg>
          </button>
        ) : (
          <button
            aria-label={TEXT.composer.send}
            className="send-button-icon"
            disabled={!canSend}
            onClick={submit}
            title={TEXT.composer.send}
            type="button"
          >
            <span aria-hidden="true" className="send-glyph" />
          </button>
        )}
      </div>

      {landing ? (
        <div className="composer-strip">
          <ProjectPicker
            activeProjectId={activeProjectId}
            label={projectName ?? TEXT.landing.projectDirectory}
            onCreateProject={onCreateProject}
            onSelectProject={onSelectProject}
            projects={projects}
          />
        </div>
      ) : null}
    </div>
  );
}
