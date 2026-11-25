// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { TEXT } from "../src/text.js";
import { IdeaTreeSettings } from "../src/views/settings/IdeaTreeSettings.js";

const SETTINGS = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  maxTokens: null,
  maxDepth: 5,
  maxNodes: 100,
  scoreDirection: "maximize",
  designSystemPrompt: "",
};

const IDEA = TEXT.settings.system.ideaTree;

function client(options: { failRead?: boolean; settings?: typeof SETTINGS } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const settings = options.settings ?? SETTINGS;
  const stub = {
    calls,
    request: async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      if (options.failRead) throw new ApiRequestError("Evolve is not initialized or unavailable", 503);
      if ((init?.method ?? "GET") === "PUT") return { ...settings, ...(JSON.parse(init!.body!) as object) };
      return settings;
    },
  };
  return stub as unknown as ApiClient & { calls: typeof calls };
}

async function flush(times = 8): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

async function mount(api: ApiClient): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: api })); });
  await act(async () => { await flush(); });
  return view;
}

/** The input is a controlled component, so every handler has to be read off the
 *  render that follows the keystroke it belongs to. */
function box(view: ReactTestRenderer, label: string): ReactTestInstance {
  return view.root.findAll((node) => node.type === "input" && node.props["aria-label"] === label)[0]!;
}

/** What a browser hands a number input: `value` is the text it can represent and
 *  `validity.badInput` says whether it holds text it cannot (e.g. `1e999`). */
function edited(value: string, badInput = false) {
  const validity = { badInput };
  return { currentTarget: { validity, value }, target: { validity, value } };
}

async function type(view: ReactTestRenderer, label: string, text: string): Promise<void> {
  await act(async () => { box(view, label).props.onChange(edited(text)); });
}

/** The native input event, which React still delivers when its `value` comparison
 *  would suppress the change event for the same empty text. */
async function input(view: ReactTestRenderer, label: string, text: string, badInput: boolean): Promise<void> {
  await act(async () => { box(view, label).props.onInput(edited(text, badInput)); });
}

async function blur(view: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => { box(view, label).props.onBlur(); });
}

/** The note the box points at with `aria-describedby`, if it is marked. */
function describedNote(view: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  const id = box(view, label).props["aria-describedby"];
  return id === undefined ? undefined : view.root.findAll((node) => node.props?.id === id)[0];
}

async function save(view: ReactTestRenderer): Promise<void> {
  const button = view.root.findAll((node) => node.type === "button" && JSON.stringify(node.props.children).includes(IDEA.save))[0]!;
  await act(async () => { button.props.onClick(); });
  await act(async () => { await flush(); });
}

const puts = (api: { calls: Array<{ method: string }> }) => api.calls.filter((call) => call.method === "PUT");
const markup = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

test("the pane renders only the settings the API accepts", async () => {
  const view = await mount(client());
  const text = markup(view);
  assert.match(text, /研究模板/);
  assert.match(text, /探索强度/);
  assert.match(text, /评分方向/);
  assert.match(text, /最大深度/);
  assert.match(text, /最大节点数/);
  // The retired engine fields must not come back through this pane.
  assert.doesNotMatch(text, /最多轮次/);
  assert.doesNotMatch(text, /每轮候选数/);
  assert.doesNotMatch(text, /评估提示词/);
  // Every stage follows the research model's thinking level, so the pane's
  // per-stage effort rows stay out; the values are no longer configurable.
  assert.doesNotMatch(text, /各阶段思考强度/);
  assert.doesNotMatch(text, /跟随模型/);
  // The save row sits at the right edge of the page, like the other settings
  // pages' actions: `is-end` is the shared modifier that does it.
  const actions = view.root.findAll((node) => node.type === "div" && String(node.props.className ?? "").includes("settings-actions"));
  assert.equal(actions.length, 1, "one action row");
  assert.equal(actions[0]!.props.className, "settings-actions is-end");
  view.unmount();
});

test("saving sends the live field set", async () => {
  const api = client();
  const view = await mount(api);
  await type(view, IDEA.maxDepth, "7");
  // Typing is a draft: it is not the form's value until the box is committed.
  assert.equal(box(view, IDEA.maxDepth).props.value, "7");
  await blur(view, IDEA.maxDepth);
  await save(view);
  const put = puts(api)[0];
  assert.ok(put, "the pane PUTs the settings");
  assert.equal(put!.path, "/api/settings/idea-tree");
  assert.equal((put!.body as { maxDepth: number }).maxDepth, 7);
  assert.equal((put!.body as { templateId: string }).templateId, "scientific-hypothesis-general/v1");
  assert.equal("rounds" in (put!.body as object), false, "retired fields are not sent");
  assert.equal("roleThinkingEfforts" in (put!.body as object), false, "stages follow the model, so no effort map is sent");
  view.unmount();
});

test("a cleared box keeps the empty text instead of snapping back to the old value", async () => {
  const api = client();
  const view = await mount(api);
  assert.equal(box(view, IDEA.maxDepth).props.value, "5", "the stored depth is what the box opens with");
  await type(view, IDEA.maxDepth, "");
  // Before #1403 the empty text was dropped and React restored "5" here.
  assert.equal(box(view, IDEA.maxDepth).props.value, "", "clearing the box leaves it empty");
  await blur(view, IDEA.maxDepth);
  assert.equal(box(view, IDEA.maxDepth).props.value, "", "the refused commit does not put the old value back");
  assert.equal(box(view, IDEA.maxDepth).props["aria-invalid"], true);
  assert.ok(markup(view).includes(IDEA.numberRange(1, 20)), "the box says which range it accepts");
  const note = describedNote(view, IDEA.maxDepth);
  assert.ok(note, "the marked box is described by its note, not only by an announcement");
  assert.equal(note!.props.role, "alert");
  assert.ok(JSON.stringify(note!.children).includes(IDEA.numberRange(1, 20)));
  await save(view);
  assert.equal(puts(api).length, 0, "a refused depth is not saved as something else");
  view.unmount();
});

test("intermediate text stays while typing and is committed from its parsed value", async () => {
  const view = await mount(client());
  for (const label of [IDEA.maxDepth, IDEA.maxNodes, IDEA.tokens]) {
    await type(view, label, "-");
    assert.equal(box(view, label).props.value, "-", `${label} keeps a leading minus`);
    assert.equal(box(view, label).props["aria-invalid"], false, "typing is not a commit, so nothing is refused yet");
    await type(view, label, "1.");
    assert.equal(box(view, label).props.value, "1.", `${label} keeps a trailing decimal point`);
  }
  // "1." parses like SettingsNumber parses it: the commit stores 1, not the text.
  await blur(view, IDEA.maxDepth);
  assert.equal(box(view, IDEA.maxDepth).props.value, "1");
  assert.equal(box(view, IDEA.maxDepth).props["aria-invalid"], false);
  // A bare "-" does not parse, so the same box refuses it on blur.
  await type(view, IDEA.maxNodes, "-");
  await blur(view, IDEA.maxNodes);
  assert.equal(box(view, IDEA.maxNodes).props["aria-invalid"], true);
  assert.equal(box(view, IDEA.maxNodes).props.value, "-");
  view.unmount();
});

test("Enter commits the draft exactly like blur, without stealing an IME Enter", async () => {
  const api = client();
  const view = await mount(api);
  await type(view, IDEA.maxNodes, "9");
  const seen = { blurred: false, prevented: false };
  const enter = (composing: boolean) => ({
    key: "Enter",
    isComposing: composing,
    nativeEvent: { isComposing: composing },
    preventDefault: () => { seen.prevented = true; },
    currentTarget: { blur: () => { seen.blurred = true; void blur(view, IDEA.maxNodes); } },
  });
  await act(async () => { box(view, IDEA.maxNodes).props.onKeyDown(enter(true)); });
  assert.equal(seen.blurred, false, "the Enter that accepts an IME candidate is not a commit");
  await act(async () => { box(view, IDEA.maxNodes).props.onKeyDown(enter(false)); });
  assert.equal(seen.prevented, true);
  assert.equal(seen.blurred, true);
  assert.equal(box(view, IDEA.maxNodes).props.value, "9", "the committed value replaces the draft text");
  await save(view);
  assert.equal((puts(api)[0]!.body as { maxNodes: number }).maxNodes, 9);
  view.unmount();
});

test("an empty token box is the API's no-cap, committed as null", async () => {
  const api = client({ settings: { ...SETTINGS, maxTokens: 200_000 } });
  const view = await mount(api);
  assert.equal(box(view, IDEA.tokens).props.value, "200000");
  assert.equal(box(view, IDEA.tokens).props.placeholder, IDEA.noCap);
  await type(view, IDEA.tokens, "");
  await blur(view, IDEA.tokens);
  // Empty is a documented value here, so it is not an error.
  assert.equal(box(view, IDEA.tokens).props["aria-invalid"], false);
  assert.ok(!markup(view).includes(IDEA.invalidNumbers));
  await save(view);
  const body = puts(api)[0]!.body as { maxDepth: number; maxTokens: number | null };
  assert.equal(body.maxTokens, null, "empty means no extra cap");
  assert.equal(body.maxDepth, 5, "the other boxes keep their values");
  view.unmount();
});

test("out-of-range values keep their text, are marked and never reach the PUT", async () => {
  const api = client();
  const view = await mount(api);
  const cases = [
    { label: IDEA.maxDepth, refused: "21", accepted: "20", range: IDEA.numberRange(1, 20) },
    { label: IDEA.maxNodes, refused: "1", accepted: "2", range: IDEA.numberRange(2, 10_000) },
    { label: IDEA.tokens, refused: "-5", accepted: "5", range: IDEA.numberOrEmpty(1, Number.MAX_SAFE_INTEGER) },
  ];
  for (const item of cases) {
    await type(view, item.label, item.refused);
    await blur(view, item.label);
    assert.equal(box(view, item.label).props.value, item.refused, `${item.label} keeps the refused text`);
    assert.equal(box(view, item.label).props["aria-invalid"], true, `${item.label} is marked`);
    assert.ok(markup(view).includes(item.range), `${item.label} says what it accepts`);
    assert.ok(markup(view).includes(IDEA.invalidNumbers), "the save row says why it is blocked");
    await save(view);
    assert.equal(puts(api).length, 0, `${item.label}: nothing is written while a box is refused`);
  }
  for (const item of cases) {
    await type(view, item.label, item.accepted);
    await blur(view, item.label);
    assert.equal(box(view, item.label).props["aria-invalid"], false, `${item.label}: correcting the text clears the mark`);
    assert.equal(box(view, item.label).props.value, item.accepted);
    assert.equal(describedNote(view, item.label), undefined, `${item.label}: an accepted box describes nothing`);
  }
  assert.ok(!markup(view).includes(IDEA.invalidNumbers));
  await save(view);
  const body = puts(api)[0]!.body as { maxDepth: number; maxNodes: number; maxTokens: number | null };
  assert.deepEqual(
    { maxDepth: body.maxDepth, maxNodes: body.maxNodes, maxTokens: body.maxTokens },
    { maxDepth: 20, maxNodes: 2, maxTokens: 5 },
    "only the accepted values are sent",
  );
  view.unmount();
});

test("text the browser cannot parse is refused, not read as an empty box", async () => {
  const api = client({ settings: { ...SETTINGS, maxTokens: 200_000 } });
  const view = await mount(api);
  // Chromium reports `1e999` (and anything else a number cannot hold) as
  // `value=""` with `validity.badInput = true`. Read as empty, the token box would
  // turn a typo into "no cap" and the depth box into the old depth.
  await input(view, IDEA.tokens, "", true);
  await blur(view, IDEA.tokens);
  assert.equal(box(view, IDEA.tokens).props["aria-invalid"], true, "the token box is marked");
  assert.ok(markup(view).includes(IDEA.numberOrEmpty(1, Number.MAX_SAFE_INTEGER)));
  await input(view, IDEA.maxDepth, "", true);
  await blur(view, IDEA.maxDepth);
  assert.equal(box(view, IDEA.maxDepth).props["aria-invalid"], true, "the depth box is marked");
  await save(view);
  assert.equal(puts(api).length, 0, "unparsable text is not saved as null or as the old value");
  // The native input event is what makes the box editable again: clearing it keeps
  // `value=""`, which the change event alone would not report.
  await input(view, IDEA.tokens, "", false);
  await blur(view, IDEA.tokens);
  assert.equal(box(view, IDEA.tokens).props["aria-invalid"], false, "clearing it again is accepted");
  await type(view, IDEA.maxDepth, "6");
  await blur(view, IDEA.maxDepth);
  assert.equal(box(view, IDEA.maxDepth).props["aria-invalid"], false);
  await save(view);
  const body = puts(api)[0]!.body as { maxDepth: number; maxNodes: number; maxTokens: number | null };
  assert.equal(body.maxTokens, null, "the cleared token box means no cap");
  assert.equal(body.maxDepth, 6, "the depth is the value the user typed, not the one badInput hid");
  assert.equal(body.maxNodes, 100, "an untouched box keeps its value");
  view.unmount();
});

test("a saved form stops claiming success once a box is edited or refused", async () => {
  const api = client();
  const view = await mount(api);
  await type(view, IDEA.maxDepth, "7");
  await blur(view, IDEA.maxDepth);
  await save(view);
  assert.ok(markup(view).includes(IDEA.saved), "the save reports success");
  // Editing starts a new attempt, so the old success note no longer describes it.
  await type(view, IDEA.maxDepth, "21");
  assert.ok(!markup(view).includes(IDEA.saved), "typing drops the success note");
  await blur(view, IDEA.maxDepth);
  assert.ok(!markup(view).includes(IDEA.saved), "a refused commit does not bring it back");
  assert.equal(box(view, IDEA.maxDepth).props["aria-invalid"], true);
  assert.ok(markup(view).includes(IDEA.numberRange(1, 20)));
  view.unmount();
});

test("a token cap beyond the largest storable integer is refused", async () => {
  const api = client();
  const view = await mount(api);
  await type(view, IDEA.tokens, `${Number.MAX_SAFE_INTEGER}0`);
  await blur(view, IDEA.tokens);
  assert.equal(box(view, IDEA.tokens).props["aria-invalid"], true, "an unsafe integer is not accepted");
  assert.ok(
    markup(view).includes(IDEA.numberOrEmpty(1, Number.MAX_SAFE_INTEGER)),
    "the note says what the store can hold, not only the minimum",
  );
  await save(view);
  assert.equal(puts(api).length, 0, "an unrepresentable cap is not sent to the API");
  // The largest integer the store accepts goes through unchanged.
  await type(view, IDEA.tokens, String(Number.MAX_SAFE_INTEGER));
  await blur(view, IDEA.tokens);
  assert.equal(box(view, IDEA.tokens).props["aria-invalid"], false);
  await save(view);
  assert.equal((puts(api)[0]!.body as { maxTokens: number }).maxTokens, Number.MAX_SAFE_INTEGER);
  view.unmount();
});

test("a 503 is shown as a prerequisite, not as an empty form", async () => {
  const api = client({ failRead: true });
  const view = await mount(api);
  const text = markup(view);
  assert.match(text, /尚未就绪/);
  view.unmount();
});
