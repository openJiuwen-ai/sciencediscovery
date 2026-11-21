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
 * Whether a draft is an Idea Tree command that should open the parameters card
 * first (#1277).
 *
 * Deferring is a UI step, not an interception: the command is sent unchanged
 * once the card is confirmed, because the agent has to receive it to run its
 * preparation and call `create_idea_research`. `confirmed` is what keeps the
 * second pass from asking again.
 */
import { isIdeaTreeCommand } from "./command.js";

export function defersIdeaSend(text: string, confirmed: boolean): boolean {
  return !confirmed && isIdeaTreeCommand(text);
}
