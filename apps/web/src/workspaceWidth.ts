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

export const DEFAULT_WORKSPACE_WIDTH = 390;
export const MIN_WORKSPACE_WIDTH = 320;
export const MIN_CONVERSATION_WIDTH = 380;

const DEFAULT_SIDEBAR_WIDTH = 280;
const COMPACT_SIDEBAR_WIDTH = 240;
const COMPACT_SIDEBAR_BREAKPOINT = 1180;

export function fallbackSidebarWidth(viewportWidth: number): number {
  return viewportWidth <= COMPACT_SIDEBAR_BREAKPOINT
    ? COMPACT_SIDEBAR_WIDTH
    : DEFAULT_SIDEBAR_WIDTH;
}

export function workspaceMaxWidth(viewportWidth: number, sidebarWidth: number): number {
  return Math.max(
    MIN_WORKSPACE_WIDTH,
    Math.floor(viewportWidth - sidebarWidth - MIN_CONVERSATION_WIDTH),
  );
}

export function clampWorkspaceWidth(value: number, maxWidth: number): number {
  const safeMax = Math.max(MIN_WORKSPACE_WIDTH, Math.floor(maxWidth));
  return Math.min(safeMax, Math.max(MIN_WORKSPACE_WIDTH, value));
}
