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

import type { ResolvedProxy } from "@sciencediscovery/schema";

import type { ProviderErrorCode } from "./http.js";

/** One normalized search hit, shared by every paid provider and free engine. */
export interface SearchRow {
  content: string;
  title: string;
  url: string;
}

/** Everything a provider needs beyond its query/URL argument. */
export interface ProviderCallOptions {
  apiKey?: string;
  /** Result cap; engines must not return more than the aggregation asked for. */
  maxResults: number;
  /** Already resolved by the broker, so providers never read policy or env. */
  proxy?: ResolvedProxy;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** One outbound try, surfaced so multi-endpoint failover stays auditable. */
export interface ProviderAttemptRecord {
  durationMs: number;
  endpoint?: string;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  isError: boolean;
}

/** A fetch provider that reports per-endpoint attempts (currently Jina). */
export interface ProviderFetchResult {
  attempts: ProviderAttemptRecord[];
  content: string;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
}
