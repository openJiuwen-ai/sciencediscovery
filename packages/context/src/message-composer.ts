// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { ContextAttachment } from "./contributor.js";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface ContextMessageComposer<TMessage extends RuntimeMessage> {
  compose(input: {
    attachments: readonly ContextAttachment[];
    history: readonly TMessage[];
    messages: readonly TMessage[];
  }): TMessage[];
}

/** Builds invocation-local data messages without mutating canonical history. */
export class DefaultContextMessageComposer<TMessage extends RuntimeMessage>
implements ContextMessageComposer<TMessage> {
  compose(input: {
    attachments: readonly ContextAttachment[];
    history: readonly TMessage[];
    messages: readonly TMessage[];
  }): TMessage[] {
    const output = structuredClone([...input.history]);
    for (const message of input.messages) {
      if (message.role !== "user") {
        throw new Error(`Context contributors may only add user messages, received role: ${String(message.role)}`);
      }
      const copy = structuredClone(message);
      const additional = typeof copy.additional_kwargs === "object"
        && copy.additional_kwargs !== null
        && !Array.isArray(copy.additional_kwargs)
        ? copy.additional_kwargs as Record<string, unknown>
        : {};
      (copy as RuntimeMessage).additional_kwargs = {
        ...additional,
        context_contributor_message: true,
        hide_from_ui: true,
      };
      output.push(copy);
    }
    for (const attachment of input.attachments) {
      output.push({
        role: "user",
        content: [
          `<context_data source="${escapeAttribute(attachment.source)}" trust="${attachment.trust}">`,
          attachment.content,
          "</context_data>",
        ].join("\n"),
        additional_kwargs: {
          context_attachment_id: attachment.id,
          hide_from_ui: true,
        },
      } as unknown as TMessage);
    }
    return output;
  }
}
