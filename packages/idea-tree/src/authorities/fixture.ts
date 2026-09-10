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

import type { IdeaTreeResultAuthority } from "../authority.js";
import { IDEA_TREE_TEAM_CONTRACT, matchesIdeaTreeTeamContract } from "../contract.js";
import { createIdeaTreeResultTool } from "../result-tool.js";

export const fixtureIdeaTreeAuthority: IdeaTreeResultAuthority = {
  createLeadTools(context, executor) {
    const tool = createIdeaTreeResultTool(context.runtime, executor, {
      resolveArtifact: async (identity) => (await context.artifacts.resolve({
        ...identity,
        executor,
        sessionId: context.sessionId,
      })).snapshot,
    });
    return tool ? [tool] : [];
  },
  developmentOnly: true,
  key: IDEA_TREE_TEAM_CONTRACT.resultAuthority.key,
  supports: matchesIdeaTreeTeamContract,
  version: IDEA_TREE_TEAM_CONTRACT.resultAuthority.version,
};
