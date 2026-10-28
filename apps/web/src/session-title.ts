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

import { UNTITLED_SESSION_TITLE, type Session } from "@sciencediscovery/schema";

type SessionTitleEntry = Pick<Session, "createdAt" | "id" | "title">;

/**
 * Gives otherwise identical default Session titles a stable, display-only
 * ordinal within the Project. The persisted sentinel stays intact so the
 * first-message title refinement can still recognize a new Session.
 */
export function sessionDisplayTitle(
  session: SessionTitleEntry,
  sessions: readonly SessionTitleEntry[],
  untitledSessionLabel: string,
): string {
  if (session.title !== UNTITLED_SESSION_TITLE) return session.title;
  const untitledSessions = sessions
    .filter((item) => item.title === UNTITLED_SESSION_TITLE)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (untitledSessions.length <= 1) return untitledSessionLabel;
  const index = untitledSessions.findIndex((item) => item.id === session.id);
  return index < 0 ? untitledSessionLabel : `${untitledSessionLabel} ${index + 1}`;
}
