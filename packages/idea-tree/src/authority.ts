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

import type { IdeaTreeExecutorDescriptor } from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";

import type { IdeaTreeArtifactResolver, IdeaTreeAuthorityRuntime, IdeaTreePhaseEventSink } from "./ports.js";

export interface IdeaTreeAuthorityContext {
  artifacts: IdeaTreeArtifactResolver;
  events?: IdeaTreePhaseEventSink;
  runId: string;
  runtime: IdeaTreeAuthorityRuntime;
  sessionId: string;
}

export interface IdeaTreeResultAuthority {
  createLeadTools(context: IdeaTreeAuthorityContext, executor: IdeaTreeExecutorDescriptor): AgentTool[];
  developmentOnly: boolean;
  key: string;
  supports(executor: IdeaTreeExecutorDescriptor): boolean;
  version: string;
}

export class IdeaTreeAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IdeaTreeAuthorityError";
  }
}

export class IdeaTreeAuthorityRegistry {
  private readonly authorities = new Map<string, IdeaTreeResultAuthority>();

  private identity(key: string, version: string): string {
    return `${key}@${version}`;
  }

  register(authority: IdeaTreeResultAuthority): this {
    const identity = this.identity(authority.key, authority.version);
    if (this.authorities.has(identity)) {
      throw new IdeaTreeAuthorityError("AUTHORITY_DUPLICATE", `Idea Tree Result Authority already registered: ${identity}`);
    }
    this.authorities.set(identity, authority);
    return this;
  }

  resolve(executor: IdeaTreeExecutorDescriptor): IdeaTreeResultAuthority {
    const identity = this.identity(executor.resultAuthority.key, executor.resultAuthority.version);
    const authority = this.authorities.get(identity);
    if (!authority || !authority.supports(executor)) {
      throw new IdeaTreeAuthorityError(
        "AUTHORITY_NOT_INSTALLED",
        `Idea Tree Executor ${executor.workflowSkill.id} requires unavailable Result Authority ${identity}`,
      );
    }
    return authority;
  }

  capability(executor: IdeaTreeExecutorDescriptor): {
    authorityKey: string;
    authorityVersion: string;
    available: boolean;
    developmentOnly: boolean;
    reason?: string;
  } {
    try {
      const authority = this.resolve(executor);
      return {
        authorityKey: authority.key,
        authorityVersion: authority.version,
        available: true,
        developmentOnly: authority.developmentOnly,
      };
    } catch (error) {
      return {
        authorityKey: executor.resultAuthority.key,
        authorityVersion: executor.resultAuthority.version,
        available: false,
        developmentOnly: false,
        reason: error instanceof Error ? error.message : "Result Authority is unavailable",
      };
    }
  }
}
