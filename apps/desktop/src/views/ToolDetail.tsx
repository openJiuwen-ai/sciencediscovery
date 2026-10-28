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

import type { ToolDetail as ToolDetailData } from "../app/tool-io.js";
import { ToolIoBlock } from "./ToolIoBlock.js";

/**
 * One input or result block of a tool call, opened in the panel because the
 * run column clips it.
 *
 * It draws the very block the card does, only unclipped: `onOpen` is absent,
 * so this is the same tile as a readable page rather than a second rendering
 * of the same text that could drift from the preview.
 */
export function ToolDetail({ detail }: { detail: ToolDetailData }) {
  return (
    <div className="tool-detail">
      <ToolIoBlock content={detail.content} label={detail.label} />
    </div>
  );
}
