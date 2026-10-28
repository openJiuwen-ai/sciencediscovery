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

/**
 * Which Session the sidebar puts first, and which one the app opens on its own.
 *
 * Kept out of `use-workspace` because both answers are pure: they depend only
 * on what the server listed, so they can be tested without a browser.
 */

/**
 * The Sessions as the sidebar lists them: most recently used first.
 *
 * `updatedAt` is an ISO-8601 string from the server's clock, so comparing the
 * strings orders them exactly as comparing the instants would. The sort is
 * stable, which leaves sessions touched in the same millisecond in the order
 * the server listed them.
 */
export function byRecency<T extends { updatedAt: string }>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The title the service stores for a Session nobody has named.
 *
 * Repeated here rather than imported from `@sciencediscovery/schema` on
 * purpose: this app reaches the schema for types only, which is what keeps its
 * runtime out of the browser bundle (`api/types.ts` says so). A value import
 * would pull the whole barrel in to compare two strings.
 */
const UNTITLED_SESSION_TITLE = "Untitled session";

/** Whether a Session still has no name. The first message names it, so an
 *  unnamed Session is also one nothing has been written in — see
 *  `reusableDraft`. */
export function untitled(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === "" || trimmed === UNTITLED_SESSION_TITLE;
}

/**
 * The Session 新建会话 should open instead of writing another one.
 *
 * The service names a Session from its first message, so one that is still
 * untitled has never been written in: it *is* the empty page the button was
 * asking for. Creating a second beside it only adds a row the user cannot tell
 * apart from the first — five of them, after five hopeful clicks.
 *
 * Archived Sessions are not reused: a click that lands on a read-only page
 * would read as a broken button.
 */
export function reusableDraft<T extends { archivedAt?: string; title: string; updatedAt: string }>(
  sessions: readonly T[],
): T | undefined {
  return byRecency(sessions).find(
    (session) => session.archivedAt === undefined && untitled(session.title),
  );
}

/**
 * The Session to open once the first listing arrives, if any.
 *
 * The sidebar lists what the server has, but the composer starts life in a
 * draft with no Session behind it. Left that way, the first message creates a
 * Session beside the one already on screen — the list grows by one rather than
 * the message landing in the conversation the user was looking at. Opening the
 * most recent Session makes the two agree from the start, and is exactly what
 * clicking that row would have done.
 *
 * A Session already open wins, and yields nothing: on a re-run of the bootstrap
 * effect the user's choice (or the app's earlier resume) must not be replaced.
 *
 * The whole Session is returned rather than its id because the listing spans
 * every Project. Resuming the newest Session without also adopting the Project
 * it belongs to would leave the app pointing at one Project while showing a
 * conversation from another, and the next 新增会话 or upload would be filed
 * under the wrong one.
 */
export function resumeSession<T extends { id: string; updatedAt: string }>(
  open: string | undefined,
  sessions: readonly T[],
): T | undefined {
  if (open !== undefined) return undefined;
  return byRecency(sessions)[0];
}

/**
 * Carries out the boot-time resume against the first listing that arrives.
 *
 * The effect in `use-workspace` is only the caller: everything that can go
 * wrong — running twice, acting on a failed read, opening the Session without
 * its Project — is decided here, where it can be tested without a browser.
 *
 * A failed listing (`undefined`) is not an empty one, so it neither opens
 * anything nor counts as tried; the next bootstrap run gets to try again.
 */
export function resumeOnBoot<T extends { id: string; projectId: string; updatedAt: string }>({
  adoptProject,
  listed,
  open,
  opened,
  openSession,
}: {
  /** Files later writes under the Project the resumed Session belongs to. */
  adoptProject: (projectId: string) => void;
  /** The listing as `refreshSessionLists` returned it. */
  listed: readonly T[] | undefined;
  /** The Session already open, if the user (or an earlier boot) chose one. */
  open: string | undefined;
  /** Set once a listing has been acted on, so a later bootstrap run — the
   *  setup wizard finishing, or a re-render — keeps the user's choice. */
  opened: { current: boolean };
  openSession: (id: string) => void;
}): void {
  if (opened.current || listed === undefined) return;
  opened.current = true;
  const target = resumeSession(open, listed);
  if (target === undefined) return;
  // The Project goes first: `openSession` is asynchronous, and anything the
  // user starts while it loads should already be filed under the right one.
  adoptProject(target.projectId);
  openSession(target.id);
}
