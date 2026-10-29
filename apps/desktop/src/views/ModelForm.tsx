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

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { ApiClient } from "../api/client.js";
import {
  addProviderModel,
  createProvider,
  previewProviderModels,
  setGlobalModel,
  testModel,
  updateProvider,
} from "../api/models.js";
import type {
  CreateModelProviderRequest,
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ProviderModelEntry,
} from "../api/types.js";
import { TEXT } from "../text.js";
import { providerName } from "./provider-name.js";

export interface ModelFormResult {
  profile: ModelProfile;
  providerId: string;
}

interface Props {
  client: ApiClient;
  /** Called once the profile exists, passed its connectivity test and became
   *  the default. */
  onConfigured: (result: ModelFormResult) => void | Promise<void>;
  /** Closes the form without writing the default selection. The wizard has no
   *  cancel of its own — the model step has to be completed — so it omits
   *  this. */
  onCancel?: () => void;
  onProvidersChanged: () => void;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
  /** The save button's own wording: the wizard continues, settings saves. */
  submitLabel: string;
  /** The wizard's 测试并继续: the final button stays hidden until a test passes,
   *  and any edit that could change connectivity hides it again. Settings keeps
   *  both buttons visible, so the default is false. */
  revealSubmitOnSuccess?: boolean;
  /** Wording for the test button while it is the wizard's primary action. */
  testLabel?: string;
  /** Rendered at the end of the action row. The wizard puts 返回上一步 here so
   *  it sits beside the continue button instead of below the form. */
  trailingAction?: ReactNode;
}

type Verdict = { kind: "fail" | "ok" | "testing"; message: string };

type Protocol = NonNullable<CreateModelProviderRequest["apiProtocol"]>;

/** The three wire shapes a hand-configured gateway can speak. Everything else
 *  about a custom provider is inferred from the protocol, the same way the
 *  server does it for a preset (`DEFAULT_MODEL_DISCOVERY`). */
const CUSTOM_PROTOCOLS: Protocol[] = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
];

const CUSTOM_VARIANT: Record<string, NonNullable<CreateModelProviderRequest["apiVariant"]>> = {
  "anthropic-messages": "anthropic-legacy",
  "openai-chat-completions": "openai",
  "openai-responses": "responses",
};

const CUSTOM_DISCOVERY: Record<string, NonNullable<CreateModelProviderRequest["modelDiscovery"]>> = {
  "anthropic-messages": "anthropic-models",
  "openai-chat-completions": "openai-models",
  "openai-responses": "openai-models",
};

const CUSTOM = "__custom__";

interface ModelComboProps {
  /** The busy channel of the surrounding ModelForm ("fetch"/"test"/"save"). */
  disabled: boolean;
  invalidate: () => void;
  listing: ProviderModelEntry[];
  onModelChange: (next: string) => void;
  placeholder: string;
  value: string;
}

/**
 * The 模型名称 field: one input that both carries a hand-typed value and
 * offers the fetched listing through a dropdown of our own. It replaced a
 * native <datalist>, whose two traits could not be fixed in place: it filters
 * the suggestions by the input's current value, so after picking GLM-5.2 the
 * dropdown only ever offered GLM-5.2 again (users could not switch models),
 * and its picker indicator sits low in the box. Opening this dropdown always
 * shows the whole listing (typing filters only while typing), the caret is
 * centered by our own CSS, and with no listing fetched it degrades to a plain
 * input for gateways without a /models endpoint.
 */
function ModelComboBox({
  disabled,
  invalidate,
  listing,
  onModelChange,
  placeholder,
  value,
}: ModelComboProps) {
  const [open, setOpen] = useState(false);
  /** What the dropdown filters on. Reset on every open, so the freshly opened
   * menu lists everything regardless of what the input already holds; only
   * typing after the open narrows it. */
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const needle = query.trim().toLowerCase();
  const options = open
    ? needle === ""
      ? listing
      : listing.filter(
          (entry) =>
            entry.id.toLowerCase().includes(needle) ||
            (entry.displayName ?? "").toLowerCase().includes(needle),
        )
    : [];

  useEffect(() => {
    if (!open || activeIndex < 0 || !menuRef.current) return;
    menuRef.current.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const applyChoice = (id: string) => {
    onModelChange(id);
    invalidate();
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  };

  const closeMenu = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  };

  const openMenu = () => {
    setQuery("");
    setActiveIndex(-1);
    setOpen(true);
    // Selecting the current value lets a keystroke replace it at once, while
    // the dropdown itself still shows the unfiltered listing (see `query`).
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) {
      if (event.key === "ArrowDown" && listing.length > 0) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const entry = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (entry) {
        event.preventDefault();
        applyChoice(entry.id);
      } else {
        closeMenu();
      }
    } else if (event.key === "Escape") {
      // Close only the dropdown here; the surrounding dialog (settings modal,
      // wizard step) must not see this Escape.
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    }
  };

  return (
    <span className="field-combo">
      <input
        aria-autocomplete="list"
        aria-expanded={open}
        className="field-input"
        disabled={disabled}
        onBlur={closeMenu}
        onChange={(event) => {
          onModelChange(event.target.value);
          setQuery(event.target.value);
          invalidate();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        value={value}
      />
      {listing.length > 0 ? (
        <button
          aria-expanded={open}
          className="field-combo-toggle"
          disabled={disabled}
          onClick={() => (open ? closeMenu() : openMenu())}
          type="button"
        >
          <span aria-hidden="true" className="field-combo-caret" />
        </button>
      ) : null}
      {open && options.length > 0 ? (
        <ul className="field-combo-menu" ref={menuRef} role="listbox">
          {options.map((entry, index) => (
            <li
              aria-selected={index === activeIndex}
              className={`field-combo-option${index === activeIndex ? " is-active" : ""}${
                entry.id === value ? " is-current" : ""
              }`}
              key={entry.id}
              onClick={() => applyChoice(entry.id)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
            >
              <span className="field-combo-option-id">{entry.id}</span>
              {entry.displayName && entry.displayName !== entry.id ? (
                <small className="field-combo-option-name">{entry.displayName}</small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}

function failureMessage(test: ModelConnectivityTestResult): string {
  if (test.message.trim() !== "") return test.message;
  return TEXT.wizard.testCategories[test.category] ?? TEXT.errors.generic;
}

/**
 * The one place a model gets configured.
 *
 * Both the first-run wizard and 设置 › 模型 use it, because the chain is
 * identical and unforgiving: a provider must exist before a model can be added
 * to it, a profile must exist before it can be tested, and the profile must
 * exist before it can become the default — `PUT /api/settings` drops a
 * `modelId` that names nothing, so this is the one order that works.
 *
 * Picking a preset is what supplies `apiProtocol`/`apiVariant`; only the custom
 * branch asks for a protocol, because a wrong variant against a right URL reads
 * as "the key is broken" and is the most expensive thing to debug here.
 *
 * The listing is fetched through `preview-models`, which saves nothing: a
 * half-filled form must not leave a provider record behind. The model name can
 * also be typed by hand, and lands on the same save path.
 */
export function ModelForm({
  client,
  onCancel,
  onConfigured,
  onProvidersChanged,
  presets,
  providers,
  revealSubmitOnSuccess = false,
  submitLabel,
  testLabel,
  trailingAction,
}: Props) {
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? CUSTOM);
  const preset = presets.find((candidate) => candidate.id === presetId);
  const custom = preset === undefined;

  const [baseUrl, setBaseUrl] = useState(presets[0]?.baseUrl ?? "");
  const [protocol, setProtocol] = useState<Protocol>("openai-chat-completions");
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [modelName, setModelName] = useState("");
  const [listing, setListing] = useState<ProviderModelEntry[]>([]);
  const [busy, setBusy] = useState<"" | "fetch" | "submit" | "test">("");
  const [verdict, setVerdict] = useState<Verdict>();
  const [testPassed, setTestPassed] = useState(false);

  const tokenOptional = preset?.tokenOptional === true;
  const keyMissing = !tokenOptional && apiKey.trim() === "";
  const ready = modelName.trim() !== "" && baseUrl.trim() !== "" && !keyMissing;

  /** Any edit that changes what would be sent invalidates the previous test. */
  const invalidate = () => {
    setVerdict(undefined);
    setTestPassed(false);
  };

  const choosePreset = (id: string) => {
    setPresetId(id);
    const next = presets.find((candidate) => candidate.id === id);
    setBaseUrl(next?.baseUrl ?? "");
    setListing([]);
    invalidate();
  };

  const chooseProtocol = (value: string) => {
    const next = CUSTOM_PROTOCOLS.find((candidate) => candidate === value);
    if (next !== undefined) setProtocol(next);
    invalidate();
  };

  /** The body both the preview and the save send, so the listing is fetched
   *  with exactly the credentials the provider will be created with. */
  const requestBody = (): CreateModelProviderRequest => {
    const shape = preset
      ? {
          apiProtocol: preset.apiProtocol,
          apiVariant: preset.apiVariant,
          modelDiscovery: preset.modelDiscovery,
          name: preset.name,
          presetId: preset.id,
        }
      : {
          apiProtocol: protocol,
          apiVariant: CUSTOM_VARIANT[protocol] ?? "openai",
          modelDiscovery: CUSTOM_DISCOVERY[protocol] ?? "openai-models",
          name: TEXT.wizard.custom.name,
        };
    return {
      ...shape,
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() !== "" ? { apiToken: apiKey.trim() } : {}),
      ...(tokenOptional ? { tokenOptional: true } : {}),
    };
  };

  const fetchListing = async () => {
    if (baseUrl.trim() === "") return;
    setBusy("fetch");
    invalidate();
    try {
      const preview = await previewProviderModels(client, requestBody());
      setListing(preview.models);
      if (preview.models.length === 0) {
        setVerdict({ kind: "fail", message: TEXT.wizard.provider.empty });
      } else if (preview.models.length === 1) {
        // A gateway that answers with one model has already told us the answer.
        setModelName(preview.models[0]?.id ?? "");
      }
    } catch (reason) {
      // A gateway that cannot list is common (many proxies do not implement
      // /models). That is not a dead end: the manual field below is the
      // fallback, so this reports the failure without blocking the save.
      setVerdict({
        kind: "fail",
        message: reason instanceof Error ? reason.message : TEXT.errors.generic,
      });
    } finally {
      setBusy("");
    }
  };

  /** Both actions need a complete form; the missing field is what the user has
   *  to hear about, so the refusal is the same one either way. */
  const refuseIncomplete = (): boolean => {
    if (ready) return false;
    setVerdict({
      kind: "fail",
      message: keyMissing ? TEXT.wizard.missingKey : TEXT.wizard.missingModel,
    });
    setTestPassed(false);
    return true;
  };

  /**
   * Write the provider and its model, leaving the default selection alone.
   *
   * Reuse the provider that already answers this endpoint: the base URL is what
   * identifies it, and a duplicate would split one configuration across two
   * rows in 设置 with the key on only one of them. Adding the same model twice
   * is idempotent on the server, so 测试 followed by 保存 does not leave two
   * profiles behind.
   */
  const persist = async (): Promise<ModelFormResult> => {
    const body = requestBody();
    const existing = providers.find(
      (provider) => provider.baseUrl === body.baseUrl && provider.presetId === body.presetId,
    );
    const provider = existing
      ? await updateProvider(client, existing.id, body)
      : await createProvider(client, body);
    const profile = await addProviderModel(client, provider.id, { model: modelName.trim() });
    onProvidersChanged();
    return { profile, providerId: provider.id };
  };

  /**
   * 测试: save the profile so it can be tested, then report the answer and stop
   * there. A profile has to exist before `POST /api/models/:id/test` will take
   * it, and the save is the same idempotent one 保存 would do, so testing first
   * leaves the catalog in a state the next click can build on.
   */
  const runTest = async () => {
    if (refuseIncomplete()) return;
    setBusy("test");
    setVerdict({ kind: "testing", message: TEXT.wizard.testing });
    try {
      const { profile } = await persist();
      const test = await testModel(client, profile.id);
      setVerdict(
        test.ok
          ? { kind: "ok", message: TEXT.wizard.testOk(test.latencyMs) }
          : { kind: "fail", message: failureMessage(test) },
      );
      setTestPassed(test.ok);
    } catch (reason) {
      setVerdict({
        kind: "fail",
        message: reason instanceof Error ? reason.message : TEXT.errors.generic,
      });
      setTestPassed(false);
    } finally {
      setBusy("");
    }
  };

  /** 保存: create, verify, and point the global default at the new profile. */
  const submit = async () => {
    if (refuseIncomplete()) return;
    setBusy("submit");
    setVerdict({ kind: "testing", message: TEXT.wizard.testing });
    try {
      const { profile, providerId } = await persist();
      const test = await testModel(client, profile.id);
      if (!test.ok) {
        // Saved but unusable. It stays in the list: the fix is correcting this
        // form (which will now find and update that record), not starting over.
        setVerdict({ kind: "fail", message: failureMessage(test) });
        setTestPassed(false);
        return;
      }

      const settings = await setGlobalModel(client, profile.id);
      if (settings.overrides.modelId !== profile.id) {
        // The write came back without the selection, which means the server did
        // not accept the id. Saying "saved" here would be a lie.
        setVerdict({ kind: "fail", message: TEXT.wizard.saveFailed(providerName(profile.name)) });
        return;
      }
      setVerdict({ kind: "ok", message: TEXT.wizard.testOk(test.latencyMs) });
      await onConfigured({ profile, providerId });
    } catch (reason) {
      setVerdict({
        kind: "fail",
        message: reason instanceof Error ? reason.message : TEXT.errors.generic,
      });
      setTestPassed(false);
    } finally {
      setBusy("");
    }
  };

  const testButtonClass =
    revealSubmitOnSuccess && !testPassed ? "primary-button" : "secondary-button";
  const testButtonLabel =
    busy === "test"
      ? TEXT.wizard.testing
      : revealSubmitOnSuccess
        ? testPassed
          ? TEXT.wizard.retest
          : testLabel ?? TEXT.settings.model.test
        : TEXT.settings.model.test;
  const showSubmit = !revealSubmitOnSuccess || testPassed;

  return (
    <>
      <label className="field">
        <span className="field-label">{TEXT.wizard.provider.preset}</span>
        <select
          className="field-select"
          disabled={busy !== ""}
          onChange={(event) => choosePreset(event.target.value)}
          value={presetId}
        >
          {presets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
          <option value={CUSTOM}>{TEXT.wizard.custom.option}</option>
        </select>
      </label>

      {custom ? (
        <label className="field">
          <span className="field-label">{TEXT.wizard.custom.protocol}</span>
          <select
            className="field-select"
            disabled={busy !== ""}
            onChange={(event) => chooseProtocol(event.target.value)}
            value={protocol}
          >
            {CUSTOM_PROTOCOLS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {TEXT.wizard.custom.protocols[candidate] ?? candidate}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="field">
        <span className="field-label">{TEXT.wizard.provider.baseUrl}</span>
        <input
          className="field-input"
          disabled={busy !== ""}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setListing([]);
            invalidate();
          }}
          spellCheck={false}
          value={baseUrl}
        />
      </label>

      <label className="field">
        <span className="field-label">
          {TEXT.wizard.provider.apiKey}
          {tokenOptional ? <span className="opt">{TEXT.wizard.optional}</span> : null}
        </span>
        <span className="field-secret">
          <input
            autoComplete="off"
            className="field-input"
            disabled={busy !== ""}
            onChange={(event) => {
              setApiKey(event.target.value);
              invalidate();
            }}
            placeholder={
              tokenOptional
                ? TEXT.wizard.provider.tokenOptional
                : TEXT.wizard.provider.apiKeyPlaceholder
            }
            spellCheck={false}
            type={revealed ? "text" : "password"}
            value={apiKey}
          />
          <button
            className="field-secret-toggle"
            onClick={() => setRevealed((current) => !current)}
            type="button"
          >
            {revealed ? TEXT.wizard.provider.conceal : TEXT.wizard.provider.reveal}
          </button>
        </span>
      </label>

      <div className="field">
        <span className="field-label">{TEXT.wizard.provider.model}</span>
        {/* This field used to render a select BESIDE the hand-typed input once
         * the listing arrived, which read as two overlapping pickers for the
         * same value. The native datalist that replaced it filtered its own
         * suggestions by the input's value, so after one pick the dropdown
         * could not offer anything else — see ModelComboBox for what took
         * over. */}
        <div className="field-row is-action">
          <ModelComboBox
            disabled={busy !== ""}
            invalidate={invalidate}
            listing={listing}
            onModelChange={setModelName}
            placeholder={TEXT.wizard.provider.modelPlaceholder}
            value={modelName}
          />
          <button
            className="secondary-button"
            disabled={busy !== "" || baseUrl.trim() === ""}
            onClick={() => void fetchListing()}
            type="button"
          >
            {busy === "fetch" ? TEXT.wizard.provider.fetching : TEXT.wizard.provider.fetch}
          </button>
        </div>
      </div>

      {verdict ? (
        <div
          className={`test-result${
            verdict.kind === "ok" ? " is-ok" : verdict.kind === "fail" ? " is-fail" : ""
          }`}
        >
          {verdict.message}
        </div>
      ) : null}

      <div className="form-actions">
        <button
          className={testButtonClass}
          disabled={busy !== ""}
          onClick={() => void runTest()}
          type="button"
        >
          {testButtonLabel}
        </button>
        {showSubmit ? (
          <button
            className="primary-button"
            disabled={busy !== ""}
            onClick={() => void submit()}
            type="button"
          >
            {busy === "submit" ? TEXT.wizard.testing : submitLabel}
          </button>
        ) : null}
        {onCancel ? (
          <button
            className="secondary-button"
            disabled={busy !== ""}
            onClick={onCancel}
            type="button"
          >
            {TEXT.menu.cancel}
          </button>
        ) : null}
        {trailingAction}
      </div>
    </>
  );
}
