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

/** The write path: sign-in, creating assets, uploading versions, review. */
import { hubApiBase, hubApiConfigured } from "../catalog/api.js";

const TOKEN_KEY = "hub-token";

export interface Account {
  display_name: string;
  id: string;
  role: "admin" | "user";
  username: string;
}

export interface MyAsset {
  display_name: string;
  id: string;
  kind: string;
  latest_version: string | null;
  public_latest_version: string | null;
  visibility: string;
}

export interface ReviewItem {
  asset_id: string;
  asset_kind: string;
  asset_name: string;
  created_at: number;
  filename: string;
  publisher_name: string;
  reject_reason: string;
  size: number;
  version: string;
}

export const writeEnabled = hubApiConfigured;

export function token(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function storeToken(value: string): void {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const current = token();
  if (current) headers.set("Authorization", `Bearer ${current}`);
  const response = await fetch(`${hubApiBase}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null) as { data?: T; detail?: string } | null;
  if (!response.ok) {
    throw new Error(body?.detail ?? `request failed: ${response.status}`);
  }
  return body?.data as T;
}

export async function login(username: string, password: string): Promise<Account> {
  const data = await call<{ token: string; user: Account }>("/auth/login", {
    body: JSON.stringify({ username, password }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  storeToken(data.token);
  return data.user;
}

export async function me(): Promise<Account | null> {
  if (!token()) return null;
  try {
    return await call<Account>("/auth/me");
  } catch {
    storeToken("");
    return null;
  }
}

export async function createAsset(body: {
  category?: string;
  description?: string;
  display_name: string;
  kind: string;
  name: string;
  summary?: string;
  visibility: "private" | "public";
}): Promise<MyAsset> {
  return await call<MyAsset>("/assets", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

export async function myAssets(): Promise<MyAsset[]> {
  const data = await call<{ items: MyAsset[] }>("/assets?mine=true&page_size=100");
  return data.items;
}

export async function uploadVersion(
  assetId: string,
  version: string,
  changelog: string,
  file: File,
): Promise<void> {
  const form = new FormData();
  form.set("version", version);
  form.set("changelog", changelog);
  form.set("file", file);
  await call(`/assets/${encodeURIComponent(assetId)}/versions`, { body: form, method: "POST" });
}

export async function reviewQueue(): Promise<ReviewItem[]> {
  const data = await call<{ items: ReviewItem[] }>("/admin/reviews?state=pending");
  return data.items;
}

export async function decide(
  assetId: string,
  version: string,
  decision: "approve" | "reject",
  reason = "",
): Promise<void> {
  await call(`/admin/reviews/${encodeURIComponent(assetId)}/${encodeURIComponent(version)}`, {
    body: JSON.stringify({ decision, reason }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}
