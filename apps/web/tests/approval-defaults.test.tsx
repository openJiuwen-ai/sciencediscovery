// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from '../../../test/support/tagged/compat.mjs';
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64', 'arch:arm64'] });
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeSettingsDetails, RuntimeSettingsOverrides } from '@sciencediscovery/schema';
import { ScopedSettingsEditor, globalSettingsDraft } from '../src/ScopedSettingsEditor.js';

const details = {
  overrides: {defaultApprovalMode:'ask_for_dangerous'},
  effective: {defaultApprovalMode:'ask_for_dangerous', enabledConnectorIds:[], enabledSkillIds:[], enabledSkillLibraries:[], skillSelectionMode:'all'},
  sources: {defaultApprovalMode:'global'},
} as RuntimeSettingsDetails;

test('Global and Project controls require an explicit save; clearing restores inheritance', async () => {
  for (const skillScope of ['global', 'project'] as const) {
    const writes: RuntimeSettingsOverrides[] = [];
    let view!: ReturnType<typeof create>;
    await act(async () => { view = create(createElement(ScopedSettingsEditor, {
      details, connectors:[], models:[], skills:[], skillScope, allowInheritance:skillScope !== 'global', scopeLabel:skillScope,
      onSave: async value => { writes.push(value); },
    })); });
    const select = () => view.root.findAllByType('select').find(node => node.props.value === 'ask_for_dangerous' || node.props.value === 'always_allow')!;
    await act(async () => { select().props.onChange({target:{value:'always_allow'}}); });
    assert.equal(writes.length, 0);
    await act(async () => { await view.root.findByType('form').props.onSubmit({preventDefault(){}}); });
    assert.equal(writes[0]?.defaultApprovalMode, 'always_allow');
    await act(async () => { select().props.onChange({target:{value:''}}); });
    await act(async () => { await view.root.findByType('form').props.onSubmit({preventDefault(){}}); });
    assert.equal('defaultApprovalMode' in writes[1]!, false);
    await act(async () => view.unmount());
  }
});

test('Session settings hide defaults; global drafts retain explicit Ask and permit built-in fallback', () => {
  const html = renderToStaticMarkup(createElement(ScopedSettingsEditor, {details, connectors:[], models:[], skills:[], scopeLabel:'Session', onSave:()=>{}}));
  assert.doesNotMatch(html, /Approval mode for new sessions/);
  assert.equal(globalSettingsDraft(details).defaultApprovalMode, 'ask_for_dangerous');
  assert.equal(globalSettingsDraft({...details, overrides:{}}).defaultApprovalMode, undefined);
});
