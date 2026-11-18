// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Whether a session can be exported at all: its project must still be reachable.
 *
 * Both entry points (the sidebar row's menu and the session header) ask this
 * before opening the dialog, so a session whose project was removed, or has not
 * loaded yet, says so instead of opening an export that can only fail
 * (#1235 review 2, F5).
 */
export function canExportSession(
  session: { projectId: string },
  projects: ReadonlyArray<{ id: string }>,
  inboxProjectId?: string,
): boolean {
  return session.projectId === inboxProjectId || projects.some(project => project.id === session.projectId);
}
