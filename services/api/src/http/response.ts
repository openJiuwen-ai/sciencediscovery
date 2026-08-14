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

import type { ServerResponse } from "node:http";

import type { ApiError } from "@science-agent/schema";

export function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  send(response, statusCode, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

export function sendError(response: ServerResponse, statusCode: number, error: string): void {
  sendJson(response, statusCode, { error } satisfies ApiError);
}
