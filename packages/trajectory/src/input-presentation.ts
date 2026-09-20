// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { object, type ContextBlock } from "./index.js";

export function blockValue(block: ContextBlock): Record<string, unknown> {
  try { return object(JSON.parse(block.content)); } catch { return {}; }
}

export function toolName(value: unknown): string {
  const tool = object(value);
  const name = tool.name ?? object(tool.function).name;
  return typeof name === "string" ? name : "";
}

/** Labels describe recorded metadata; arbitrary message text is not provenance. */
export function contextLabel(block: ContextBlock, blocks: ContextBlock[], zh: boolean): string {
  const tr = (cn: string, en: string) => zh ? cn : en;
  if (block.id.startsWith("tool-")) return toolName(blockValue(block)) || tr("工具定义", "Tool definition");
  if (!block.id.startsWith("message-")) return `${tr("系统", "System")} · ${block.source}`;
  const message = blockValue(block), metadata = object(message.additional_kwargs);
  const channel = metadata.durable_context_channel;
  if (typeof channel === "string") return ({ active_skills: "Skill", artifacts: "Artifact", delegations: tr("子任务", "Delegation"), memory: tr("记忆", "Memory"), reviews: tr("评审", "Review") } as Record<string, string>)[channel] ?? channel;
  if (metadata.context_attachment_id) return tr("上下文附件", "Context attachment");
  if (metadata.context_contributor_message) return tr("组件上下文", "Contributed context");
  if (block.kind === "tool") {
    let name = toolName(message);
    if (!name && typeof message.tool_call_id === "string") {
      // Restrict lookup to prior messages in this exact request, never another run.
      const calls = blocks.slice(0, blocks.indexOf(block)).flatMap(b => {
        const value = blockValue(b);
        return Array.isArray(value.tool_calls) ? value.tool_calls : [];
      }).filter(call => object(call).id === message.tool_call_id);
      if (calls.length === 1) name = toolName(calls[0]);
    }
    return `${tr("工具结果", "Tool result")}${name ? ` · ${name}` : ""}`;
  }
  if (block.kind === "assistant") {
    const names = Array.isArray(message.tool_calls) ? message.tool_calls.map(toolName).filter(Boolean) : [];
    return names.length ? `${tr("工具调用", "Tool calls")} · ${names.join(", ")}` : tr("模型回复", "Assistant");
  }
  return ({ user: tr("用户", "User"), system: tr("系统", "System") } as Record<string, string>)[block.kind] ?? block.kind;
}

export function inputSections(blocks: ContextBlock[]) {
  return { context: blocks.filter(b => !b.id.startsWith("tool-")), tools: blocks.filter(b => b.id.startsWith("tool-")) };
}
