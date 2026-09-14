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

import type { IdeaTreeGraph, IdeaTreeState, IdeaTreeSettings } from "@sciencediscovery/schema";

export interface IdeaTreeCommandContext {
  runId?: string;
  expectedExecutorFingerprint?: string;
  settings?: IdeaTreeSettings;
}
/** A scoped connection to the Python tree service, not a second state store. */
export interface IdeaTreePersistence {
  readonly key: string;
  call<T>(operation: string, params: object, context?: IdeaTreeCommandContext): Promise<T>;
  deleteAll(): Promise<void>;
  listTreeIds(): Promise<string[]>;
  readGraph(treeId: string): Promise<IdeaTreeGraph | null>;
  readTree(treeId: string): Promise<IdeaTreeState | null>;
}
export class IdeaTreePersistenceError extends Error {
  constructor(readonly code: "PERSISTENCE_UNAVAILABLE" | "REVISION_CONFLICT" | "STORAGE_ERROR", message: string) {
    super(message);
    this.name = "IdeaTreePersistenceError";
  }
}
