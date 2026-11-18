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
 * Whether 任务 still has something to show.
 *
 * The tab is where a search's detail and an Idea Tree research's tree live. It used
 * to be kept only while the Session had a search, so opening a research's card set
 * the tab and the same render bounced it to 产物 — the panel never appeared. The
 * tab is a tab of the panel, not of Evolve, so anything the tab can draw keeps it.
 */
export function taskTabKept(evolveRunCount: number, selectedResearch: boolean): boolean {
  return evolveRunCount > 0 || selectedResearch;
}
