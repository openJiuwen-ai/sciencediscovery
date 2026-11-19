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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
import { commitsOnEnter } from "../app/ime-enter.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "./dialog-escape.js";
import { providerName } from "./provider-name.js";
import { ListSelect, type ListChoice } from "./settings/ListSelect.js";

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
  /** Bumped after a successful fetch so the freshly read listing opens itself:
   *  the reader asked for the list, so showing it is the answer. */
  revealToken: number;
  value: string;
}

/** Where the dropdown sits, in viewport coordinates. The menu is portalled to
 *  `document.body`, so it needs its own fixed geometry rather than the input's
 *  containing block — see the note on ModelComboBox. */
interface MenuGeometry {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
  width: number;
}

/** Keeps the menu on screen when the row is near an edge: the anchor's input
 *  width, at least 260px, never past the right edge. */
function menuGeometry(anchor: HTMLInputElement): MenuGeometry {
  const rect = anchor.getBoundingClientRect();
  const margin = 12;
  const below = window.innerHeight - rect.bottom - margin;
  const above = rect.top - margin;
  // Flip above when there is not enough room for a useful part of the listing
  // below. In the add dialog the field is the last one, so this is also what
  // keeps the menu in the middle of the window instead of pinned to its edge.
  const placeAbove = below < 320 && above > below;
  const room = placeAbove ? above : below;
  const width = Math.min(
    Math.max(rect.width, 260),
    Math.max(220, window.innerWidth - margin * 2),
  );
  return {
    ...(placeAbove
      ? { bottom: window.innerHeight - rect.top + 6 }
      : { top: rect.bottom + 6 }),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    maxHeight: Math.max(120, Math.min(320, room)),
    width,
  };
}

/**
 * The 模型名称 field: one input that both carries a hand-typed value and
 * offers the fetched listing through a dropdown of our own.
 *
 * The menu is portalled to `document.body` rather than positioned inside the
 * field. Both hosts (the settings modal and the wizard) clip their own content
 * — the settings modal scrolls — and an absolutely positioned menu was being
 * cut off after its first row and drawn over the action buttons. As a portal
 * it can grow to 320px, flip above the field when the modal is near the bottom
 * of the window, and keep a scrollbar the reader can actually drag.
 *
 * It opens on a click of the field as well as the caret, and closes on Escape,
 * on a pointer outside it, or on choosing an option. It deliberately does not
 * close on the input's blur: clicking or dragging the menu's scrollbar blurs
 * the input, and the old `onBlur` handler made the listing vanish mid-scroll.
 */
function ModelComboBox({
  disabled,
  invalidate,
  listing,
  onModelChange,
  placeholder,
  revealToken,
  value,
}: ModelComboProps) {
  const [open, setOpen] = useState(false);
  /** What the dropdown filters on. Reset on every open, so the freshly opened
   * menu lists everything regardless of what the input already holds; only
   * typing after the open narrows it. */
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [geometry, setGeometry] = useState<MenuGeometry>();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  /** The caret. It is inside the field but outside the input and the menu, so
   *  the capture-phase outside-pointer handler has to exempt it: closing on the
   *  button's pointerdown would let the click that follows reopen the menu. */
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const lastReveal = useRef(revealToken);

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

  const place = useCallback(() => {
    const anchor = inputRef.current;
    if (anchor) setGeometry(menuGeometry(anchor));
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    setGeometry(undefined);
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || listing.length === 0) return;
    setQuery("");
    // Start on the current value when the listing names it, so opening the
    // menu does not lose the reader's place in a long list.
    const current = listing.findIndex((entry) => entry.id === value);
    setActiveIndex(current >= 0 ? current : 0);
    setOpen(true);
    // Selecting the current value lets a keystroke replace it at once, while
    // the dropdown itself still shows the unfiltered listing (see `query`).
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [disabled, listing, value]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  /** A successful 刷新列表 hands back the listing; open it so the result of
   *  the click is visible rather than hidden behind a caret. */
  useEffect(() => {
    if (revealToken === lastReveal.current) return;
    lastReveal.current = revealToken;
    if (listing.length > 1) openMenu();
  }, [listing.length, openMenu, revealToken]);

  useEffect(() => {
    // The unit tests mount this form without a DOM; there is nothing to listen
    // on there and nothing to portal into.
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (inputRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      closeMenu();
    };
    const reposition = () => place();
    // The fields live inside a scrolling modal, so the menu has to follow it
    // rather than only the window.
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [closeMenu, open, place]);

  /** A listing that disappears (provider edited) or a form that goes busy
   *  cannot keep its menu open. */
  useEffect(() => {
    if (open && (disabled || listing.length === 0)) closeMenu();
  }, [closeMenu, disabled, listing.length, open]);

  /**
   * Escape belongs to the open listing wherever focus is.
   *
   * Clicking the list's padding or dragging its scrollbar leaves focus on the
   * page, where the input's own keydown handler cannot see the key; the
   * settings modal's document listener would then close the whole dialog.
   * Claiming Escape in the capture phase keeps one Escape to one layer, the
   * same way `ListSelect` does for the provider and protocol lists.
   */
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      closeMenu();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const applyChoice = (id: string) => {
    onModelChange(id);
    invalidate();
    closeMenu();
    // The click moved focus to the menu; hand it back so Tab continues from
    // the field and the chosen value is visible as selected text.
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Tab is the reader leaving the field, so it closes the listing even when
    // the filter has emptied the options — the empty-state popup must not stay
    // over the form while focus moves on.
    if (event.key === "Tab" && open) {
      closeMenu();
      return;
    }
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
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (commitsOnEnter(event)) {
      const entry = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (entry) {
        event.preventDefault();
        applyChoice(entry.id);
      } else {
        closeMenu();
      }
    }
  };

  return (
    <span className="field-combo">
      <input
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        autoComplete="off"
        className="field-input field-combo-input"
        disabled={disabled}
        onChange={(event) => {
          onModelChange(event.target.value);
          setQuery(event.target.value);
          setActiveIndex(-1);
          invalidate();
        }}
        onClick={() => {
          // Opening from the field itself is what makes the fetched listing
          // discoverable; the caret is a second, explicit affordance.
          if (!open && listing.length > 0) openMenu();
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
          aria-label={TEXT.wizard.provider.choose}
          className={`field-combo-toggle${open ? " is-open" : ""}`}
          disabled={disabled}
          onClick={() => (open ? closeMenu() : openMenu())}
          onMouseDown={(event) => event.preventDefault()}
          ref={toggleRef}
          type="button"
        >
          <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="14"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      ) : null}
      {open && geometry && typeof document !== "undefined"
        ? createPortal(
            // The anchor is the menu's square footprint in the surface colour.
            // The menu inside it is rounded; opened upward over the form, its
            // rounded corner would otherwise leave a sliver of the label behind
            // visible in the corner notch.
            <div className="field-combo-anchor" ref={menuRef} style={geometry}>
              <div className="field-combo-menu">
                {options.length > 0 ? (
                  <ul
                    aria-label={TEXT.wizard.provider.model}
                    className="field-combo-list"
                    id={listId}
                    ref={listRef}
                    role="listbox"
                  >
                    {options.map((entry, index) => (
                      <li
                        aria-selected={index === activeIndex}
                        className={`field-combo-option${index === activeIndex ? " is-active" : ""}${
                          entry.id === value ? " is-current" : ""
                        }`}
                        id={`${listId}-option-${index}`}
                        key={entry.id}
                        onClick={() => applyChoice(entry.id)}
                        onMouseEnter={() => setActiveIndex(index)}
                        role="option"
                        title={entry.id}
                      >
                        <span className="field-combo-option-copy">
                          <span className="field-combo-option-id">{entry.id}</span>
                          {entry.displayName && entry.displayName !== entry.id ? (
                            <small className="field-combo-option-name">{entry.displayName}</small>
                          ) : null}
                        </span>
                        {entry.id === value ? (
                          <svg
                            aria-hidden="true"
                            className="field-combo-check"
                            fill="none"
                            height="14"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2.2"
                            viewBox="0 0 24 24"
                            width="14"
                          >
                            <path d="m4 12 5 5L20 6" />
                          </svg>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-combo-empty">{TEXT.wizard.provider.noMatch(query.trim())}</p>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
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
  /** Bumped on every successful fetch that returned a list, so the combobox
   *  opens itself instead of leaving the result behind a caret. */
  const [listingToken, setListingToken] = useState(0);
  const [busy, setBusy] = useState<"" | "fetch" | "submit" | "test">("");
  const [verdict, setVerdict] = useState<Verdict>();
  const [testPassed, setTestPassed] = useState(false);
  /**
   * What a passing test left behind: the profile as it was saved, and the
   * latency it answered in.
   *
   * 测试 saves before it tests, so a pass means this exact configuration is
   * already in the catalog and already verified. The action that follows — the
   * wizard's 开始使用, settings' 保存 — can write the default onto that record
   * instead of saving and asking the provider the same question again, which
   * the reader sees as the same wait twice. Any edit clears it, together with
   * `testPassed`: both describe this form's contents, not the wizard's history.
   */
  const [verified, setVerified] = useState<(ModelFormResult & { latencyMs: number }) | undefined>();

  const tokenOptional = preset?.tokenOptional === true;
  const keyMissing = !tokenOptional && apiKey.trim() === "";
  const ready = modelName.trim() !== "" && baseUrl.trim() !== "" && !keyMissing;

  /** Any edit that changes what would be sent invalidates the previous test. */
  const invalidate = () => {
    setVerdict(undefined);
    setTestPassed(false);
    setVerified(undefined);
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
    let listed = 0;
    try {
      const preview = await previewProviderModels(client, requestBody());
      setListing(preview.models);
      listed = preview.models.length;
      if (listed === 0) {
        setVerdict({ kind: "fail", message: TEXT.wizard.provider.empty });
      } else if (listed === 1) {
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
      // Several answers: show them. The click asked for the list, and the
      // reader should not have to find the caret to see it. Bumping the token
      // after `busy` clears means the combobox opens on an enabled field in
      // the same commit.
      setBusy("");
      if (listed > 1) setListingToken((token) => token + 1);
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
      const saved = await persist();
      const test = await testModel(client, saved.profile.id);
      setVerdict(
        test.ok
          ? { kind: "ok", message: TEXT.wizard.testOk(test.latencyMs) }
          : { kind: "fail", message: failureMessage(test) },
      );
      setTestPassed(test.ok);
      setVerified(test.ok ? { ...saved, latencyMs: test.latencyMs } : undefined);
    } catch (reason) {
      setVerdict({
        kind: "fail",
        message: reason instanceof Error ? reason.message : TEXT.errors.generic,
      });
      setTestPassed(false);
      setVerified(undefined);
    } finally {
      setBusy("");
    }
  };

  /**
   * 保存 / 开始使用: point the global default at the new profile.
   *
   * A test that already passed saved this configuration and got an answer from
   * the provider, so this click has nothing left to verify: it writes the
   * default onto the record the test left. Asking again would show the same
   * spinner and the same "connected" line a second time, which reads as the
   * app testing twice. Without a pass — the reader went straight to 保存, or
   * edited the form after testing — the save and the test happen here instead,
   * exactly as before.
   */
  const submit = async () => {
    if (refuseIncomplete()) return;
    const passed = testPassed ? verified : undefined;
    setBusy("submit");
    if (passed === undefined) setVerdict({ kind: "testing", message: TEXT.wizard.testing });
    try {
      let result = passed;
      if (result === undefined) {
        const saved = await persist();
        const test = await testModel(client, saved.profile.id);
        if (!test.ok) {
          // Saved but unusable. It stays in the list: the fix is correcting this
          // form (which will now find and update that record), not starting over.
          setVerdict({ kind: "fail", message: failureMessage(test) });
          setTestPassed(false);
          return;
        }
        result = { ...saved, latencyMs: test.latencyMs };
        setVerdict({ kind: "ok", message: TEXT.wizard.testOk(test.latencyMs) });
      }

      const settings = await setGlobalModel(client, result.profile.id);
      if (settings.overrides.modelId !== result.profile.id) {
        // The write came back without the selection, which means the server did
        // not accept the id. Saying "saved" here would be a lie.
        setVerdict({ kind: "fail", message: TEXT.wizard.saveFailed(providerName(result.profile.name)) });
        return;
      }
      await onConfigured({ profile: result.profile, providerId: result.providerId });
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

  /** The two choosers are drawn by the app, not by the OS: a native
   *  `<select>` opens a system popup with the OS's own blue selection bar and
   *  none of this dialog's type or spacing. `ListSelect` keeps the same row
   *  vocabulary as the model-name listing beside it. */
  const presetChoices: ListChoice[] = [
    ...presets.map((candidate) => ({ label: candidate.name, value: candidate.id })),
    { label: TEXT.wizard.custom.option, value: CUSTOM },
  ];
  const protocolChoices: ListChoice[] = CUSTOM_PROTOCOLS.map((candidate) => ({
    label: TEXT.wizard.custom.protocols[candidate] ?? candidate,
    value: candidate,
  }));

  return (
    <div className="model-form">
      <div className="field">
        <span className="field-label">{TEXT.wizard.provider.preset}</span>
        <ListSelect
          caption={false}
          choices={presetChoices}
          disabled={busy !== ""}
          label={TEXT.wizard.provider.preset}
          onChange={choosePreset}
          value={presetId}
        />
      </div>

      {custom ? (
        <div className="field">
          <span className="field-label">{TEXT.wizard.custom.protocol}</span>
          <ListSelect
            caption={false}
            choices={protocolChoices}
            disabled={busy !== ""}
            label={TEXT.wizard.custom.protocol}
            onChange={chooseProtocol}
            value={protocol}
          />
        </div>
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
        {/* This field used to render a hand-typed input with a parallel
         * native <select> that appeared once the listing arrived, which read
         * as two overlapping pickers for the same value — see ModelComboBox
         * for what took over. */}
        <div className="field-row is-action">
          <ModelComboBox
            disabled={busy !== ""}
            invalidate={invalidate}
            listing={listing}
            onModelChange={setModelName}
            placeholder={TEXT.wizard.provider.modelPlaceholder}
            revealToken={listingToken}
            value={modelName}
          />
          <button
            className="field-refresh"
            disabled={busy !== "" || baseUrl.trim() === ""}
            onClick={() => void fetchListing()}
            title={TEXT.wizard.provider.fetchHint}
            type="button"
          >
            {busy === "fetch" ? (
              <span className="spinner" />
            ) : (
              <svg
                aria-hidden="true"
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
                width="14"
              >
                <path d="M20 11a8 8 0 1 0-2.3 6.4M20 5v6h-6" />
              </svg>
            )}
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
          <div>
            {verdict.message}
            {verdict.kind === "ok" ? (
              <small className="test-result-note">{TEXT.wizard.basicCheckNotice}</small>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="form-actions">
        {onCancel || trailingAction ? (
          <div className="form-actions-start">
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
        ) : null}
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
      </div>
    </div>
  );
}
