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

import type { ApiClient } from "../src/api/client.js";

export interface RecordedCall {
  init: RequestInit;
  path: string;
}

/**
 * A stand-in for `ApiClient` that records what a wrapper asked for.
 *
 * `ApiClient` itself is covered by `api-client.test.ts`; these tests are about
 * the contract each wrapper writes — path, method and body — so recording at
 * this seam is both simpler and more precise than intercepting `fetch`.
 */
export class StubClient {
  readonly calls: RecordedCall[] = [];
  private readonly responses: unknown[] = [];
  private readonly streams: unknown[] = [];

  /** Queue one JSON response, in call order. */
  reply(value: unknown): this {
    this.responses.push(value);
    return this;
  }

  /** Queue one rejection, in call order. */
  fail(reason: unknown): this {
    this.responses.push(reason);
    return this;
  }

  /** Queue one stream body, in call order. */
  stream(text: string): this {
    this.streams.push(text);
    return this;
  }

  readonly request = <T>(path: string, init: RequestInit = {}): Promise<T> => {
    this.calls.push({ init, path });
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as T);
  };

  readonly fetchStream = (path: string, init: RequestInit = {}): Promise<Response> => {
    this.calls.push({ init, path });
    const next = this.streams.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response(String(next ?? "")));
  };

  asClient(): ApiClient {
    return this as unknown as ApiClient;
  }
}

/** The parsed JSON body of a recorded call. */
export function json(call: RecordedCall): unknown {
  return JSON.parse(String(call.init.body));
}

/** A recorded path split into its pathname and query, so a test can assert on
 *  parameters without depending on percent-encoding details. */
export function split(call: RecordedCall): { pathname: string; query: URLSearchParams } {
  const url = new URL(call.path, "http://test.invalid");
  return { pathname: url.pathname, query: url.searchParams };
}
