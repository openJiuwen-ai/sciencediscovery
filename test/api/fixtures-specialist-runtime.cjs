#!/usr/bin/env node
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Protocol fixture only: runs under the real Runner outer sandbox. No provider calls.
const { createInterface } = require('readline');
const { readFileSync, writeFileSync } = require('fs');
(async () => {
const acp = process.env.SD_ACP_TOKEN !== undefined;
const kind = acp ? 'acp' : 'claude-code';
const secret = process.env[acp ? 'SD_ACP_TOKEN' : 'ANTHROPIC_API_KEY'];
if (secret !== 'phase3-fixture-secret' || process.argv.join(' ').includes(secret)) process.exit(12);
function decision(turn) {
  return [
    { summary: 'Write and declare output in one ordered turn', tools: [
      { tool: 'run_shell', arguments: JSON.stringify({ command: `sleep 1; printf ${kind} > result.txt; printf private > scratch.txt` }) },
      { tool: 'declare_artifact', arguments: JSON.stringify({ path: 'result.txt', name: `${kind}-result.txt` }) },
    ] },
    { tools: [], summary: `${kind} completed` },
  ][turn];
}
if (!acp) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  if (input.includes(secret)) process.exit(13);
  if (input.includes('[hold]')) await new Promise(() => { setInterval(() => {}, 1000); });
  let turn = 0; try { turn = Number(readFileSync(`${process.env.HOME}/turn`, 'utf8')); } catch {}
  writeFileSync(`${process.env.HOME}/turn`, String(turn + 1));
  console.log(JSON.stringify({ session_id: 'claude-fixture-session', structured_output: decision(turn) }));
} else {
  let turn = 0; let permissionPrompt;
  const send = value => console.log(JSON.stringify(value));
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (!message.method) {
      if (message.id === 'native-permission') {
        if ((!message.result || !message.result.outcome || message.result.outcome.outcome !== 'cancelled')) process.exit(17);
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ tools: [], summary: 'permission denied' }) } } } });
        send({ jsonrpc: '2.0', id: permissionPrompt, result: { stopReason: 'end_turn' } });
      }
      continue;
    }
    const { id, method, params } = message;
    let result;
    if (method === 'initialize') {
      if (Object.keys(params.clientCapabilities).length) process.exit(14);
      result = { protocolVersion: 1, agentCapabilities: {} };
    } else if (method === 'session/new') result = { sessionId: 'acp-fixture-session', configOptions: [{ id: 'selected-model', category: 'model', type: 'select', options: [{ value: 'fixture-model', name: 'Fixture' }] }] };
    else if (method === 'session/set_config_option') {
      if (params.configId !== 'selected-model' || params.value !== 'fixture-model') process.exit(16);
      result = { configOptions: [] };
    }
    else if (method === 'session/prompt') {
      if (JSON.stringify(params).includes(secret)) process.exit(13);
      if (JSON.stringify(params).includes('[hold]')) continue;
      if (process.argv.includes('--native-permission')) {
        permissionPrompt = id;
        send({ jsonrpc: '2.0', id: 'native-permission', method: 'session/request_permission', params: { sessionId: params.sessionId, toolCall: { toolCallId: 'native', title: 'Local exec', kind: 'execute' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] } });
        continue;
      }
      if (process.argv.includes('--native-tool')) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'native', title: 'Local exec', kind: 'execute' } } });
      const text = JSON.stringify(decision(turn++));
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      result = { stopReason: 'end_turn' };
    } else result = {};
    send({ jsonrpc: '2.0', id, result });
  }
}

})().catch(() => process.exit(20));
