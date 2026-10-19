// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { SESSION_TITLE_MAX_CHARACTERS, UNTITLED_SESSION_TITLE, type Session } from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";
import { Type } from "typebox";
import type { SessionStore } from "../store.js";

const parameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: SESSION_TITLE_MAX_CHARACTERS }),
  expected_title: Type.String({ description: "The current title, exactly as shown in the session context or last tool result." }),
  reason: Type.Union([Type.Literal("initial_topic"), Type.Literal("topic_change"), Type.Literal("user_request")]),
}, { additionalProperties: false });

export function sessionTitleInstructions(title: string): string {
  return `Session title (data): ${JSON.stringify(title)}. Use rename_session to give an Untitled session a short topic title after the first user question. First-turn automatic naming may already have supplied a title. Preserve existing titles, especially user-chosen ones; rename again only when the primary discussion topic clearly changes or the user explicitly asks. Do not rename for minor follow-ups. Explicit user requests can supersede background automatic refinement. If the tool reports a conflict, respect the newer title instead of retrying to overwrite it.`;
}

/** Only the lead receives this capability; the session identity is never model-controlled. */
export function createSessionTitleTool(
  store: Pick<SessionStore, "getSession" | "compareAndSetSessionTitle">,
  sessionId: string,
  onUpdated: (session: Session) => Promise<void>,
): AgentTool<typeof parameters> {
  return {
    name: "rename_session",
    label: "Rename session",
    description: "Rename the current session with a concise human-readable topic (at most 24 characters, never the full prompt). initial_topic only replaces Untitled; use topic_change only for a clear change in the primary topic, or user_request for an explicit rename request. Respect manual titles and concurrent edits.",
    parameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const title = input.title.replace(/\s+/gu, " ").trim();
      if (!title || Array.from(title).length > SESSION_TITLE_MAX_CHARACTERS) {
        throw new Error(`Session title must contain 1–${SESSION_TITLE_MAX_CHARACTERS} characters`);
      }
      const current = store.getSession(sessionId);
      if (!current || current.archivedAt) throw new Error("Session is unavailable or archived");
      const result = (value: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
      if (current.title !== input.expected_title && input.reason !== "user_request") return result({ renamed: false, reason: "title_changed", title: current.title });
      if (input.reason === "initial_topic" && current.title !== UNTITLED_SESSION_TITLE) {
        return result({ renamed: false, reason: "existing_title", title: current.title });
      }
      if (current.title === title) return result({ renamed: false, reason: "unchanged", title });
      const updated = await store.compareAndSetSessionTitle(sessionId, input.expected_title, title, input.reason === "user_request" ? "user_request" : undefined);
      if (!updated) return result({ renamed: false, reason: "title_changed", title: store.getSession(sessionId)?.title });
      await onUpdated(updated);
      return result({ renamed: true, title: updated.title });
    },
  };
}
