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

import { useEffect, useState } from "react";

/** The repository the star button points at. */
export const REPO_URL = "https://github.com/openJiuwen-ai/sciencediscovery";

const API_URL = "https://api.github.com/repos/openJiuwen-ai/sciencediscovery";
const CACHE_KEY = "sciencediscovery-desktop:github-stars";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Cached {
  count: number;
  at: number;
}

function readCache(): number | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<Cached>;
    if (typeof parsed.count !== "number") return undefined;
    return Date.now() - (parsed.at ?? 0) < CACHE_TTL_MS ? parsed.count : undefined;
  } catch {
    // A cache we cannot read is a cache we do not have.
    return undefined;
  }
}

function writeCache(count: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), count } satisfies Cached));
  } catch {
    // Private mode, or a full disk: the number simply is not remembered.
  }
}

/** `5.4k` for a four-digit count, the way GitHub itself abbreviates. */
export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

/**
 * The repository's star count, or `undefined` while it is unknown.
 *
 * It is read from GitHub's public API and cached for a day: the button is
 * decoration next to a link, so a rate limit or an offline machine leaves it
 * without a number rather than with an invented one.
 */
export function useGithubStars(): number | undefined {
  const [count, setCount] = useState<number | undefined>(readCache);

  useEffect(() => {
    if (readCache() !== undefined) return;
    let cancelled = false;
    fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { stargazers_count?: unknown } | undefined) => {
        const stars = body?.stargazers_count;
        if (cancelled || typeof stars !== "number") return;
        setCount(stars);
        writeCache(stars);
      })
      .catch(() => {
        // Offline, blocked by CORS, or rate limited: no number is shown.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
