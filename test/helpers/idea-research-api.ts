// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/** The Idea Tree research surface used by the browser and API journeys.
 *
 * The list is a summary projection: it carries the card fields and the ids, not
 * the tree. Journeys that inspect candidates, assessments or ROOT insight must
 * ask for that one research with `operation: "get"`, exactly as the product UI
 * and the agent summary do.
 */
import type { IdeaResearchSummary, IdeaResearchView } from "@sciencediscovery/schema";
import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";

export interface IdeaResearchHttpResponse {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The subset of Playwright's APIRequestContext this helper needs. */
export interface IdeaResearchRequest {
  get(url: string, options: { headers: Record<string, string>; timeout: number; maxRetries: number }): Promise<IdeaResearchHttpResponse>;
  post(url: string, options: { headers: Record<string, string>; data: Record<string, unknown>; timeout: number; maxRetries: number }): Promise<IdeaResearchHttpResponse>;
}

export interface IdeaResearchReadOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
}

export function ideaResearchEndpoint(sessionId: string, baseUrl = apiBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`;
}

export async function listIdeaResearches(
  request: IdeaResearchRequest,
  sessionId: string,
  options: IdeaResearchReadOptions = {},
): Promise<IdeaResearchSummary[]> {
  const url = ideaResearchEndpoint(sessionId, options.baseUrl);
  const response = await request.get(url, {
    headers: options.headers ?? authorizationHeader(),
    timeout: options.timeout ?? 10_000,
    maxRetries: options.maxRetries ?? 0,
  });
  if (!response.ok()) {
    throw new Error(`GET ${url} -> ${response.status()}: ${(await response.text()).slice(0, 200)}`);
  }
  return ((await response.json()) as { items?: IdeaResearchSummary[] }).items ?? [];
}

export async function getIdeaResearchView(
  request: IdeaResearchRequest,
  sessionId: string,
  researchId: string,
  options: IdeaResearchReadOptions = {},
): Promise<IdeaResearchView> {
  const url = ideaResearchEndpoint(sessionId, options.baseUrl);
  const response = await request.post(url, {
    headers: options.headers ?? authorizationHeader(),
    data: { operation: "get", researchId },
    timeout: options.timeout ?? 10_000,
    maxRetries: options.maxRetries ?? 0,
  });
  if (!response.ok()) {
    throw new Error(`POST ${url} -> ${response.status()}: ${(await response.text()).slice(0, 200)}`);
  }
  return await response.json() as IdeaResearchView;
}
