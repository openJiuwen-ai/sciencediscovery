// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * How the Idea Tree card learns that a research may be waiting to be drawn.
 *
 * The card refreshes when the run stream delivers `idea_research.created`, but
 * that event reaches only a client subscribed at that moment. A client that
 * attaches to a run afterwards reads the run's persisted events and starts live
 * delivery *after* the last replayed sequence, so a created event present only
 * in the replay never arrives on the stream — and the card is left with a list
 * read that ran before the research existed.
 *
 * These helpers close that hole from the two places that know a research may
 * exist while the card does not: the composer that just accepted an `/idea-tree`
 * command, and the Session attach that replayed a run. Both arm the card's
 * re-read from that moment instead of from when the card mounted, so a command
 * sent into a Session that has been open for hours still gets its card.
 */

/** Dispatched to make the Idea Tree card re-read the Session's research list. */
export const IDEA_RESEARCH_EXPECTED_EVENT = "idea-research-expected";

/** One persisted run event, as read back for a run this client did not watch. */
export interface ReplayedRunEvent { event: { type: string } }

/** The run the client is attaching to; absent when the Session has none active. */
export interface AttachedRun { id: string }

/** Arm the card's re-read from now, without waiting for its own timer. */
export function armIdeaResearchCard(sessionId: string): void {
  // Only a mounted card listens, and a mounted card needs a browser: a render
  // without `window` (a unit test's App, a non-browser host) must not fail on
  // this announcement.
  if (typeof window === "undefined" || typeof CustomEvent === "undefined"
    || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(IDEA_RESEARCH_EXPECTED_EVENT, { detail: { sessionId } }));
}

/**
 * Arm the card when the Session the client just attached to may already hold a
 * research it never saw: the run is still active, or its replay carries the
 * `idea_research.created` event. Nothing is dispatched for a Session that has
 * neither, so an ordinary refresh does not wake the card for no reason.
 */
export function announceAttachedRun(
  sessionId: string,
  replay: readonly ReplayedRunEvent[],
  activeRun: AttachedRun | null | undefined,
): void {
  const createdInReplay = replay.some((record) => record?.event?.type === "idea_research.created");
  if (!createdInReplay && !activeRun) return;
  armIdeaResearchCard(sessionId);
}

/** True when the message the composer is sending asks for an Idea Tree research. */
export function asksForIdeaResearch(message: string): boolean {
  return /^\/idea-tree(?:-team)?(?:\s|$)/u.test(message.trimStart());
}
