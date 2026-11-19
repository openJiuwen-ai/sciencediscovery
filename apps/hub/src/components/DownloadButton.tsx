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

import { useState } from "react";

import { DownloadIcon } from "./icons.js";
import { assetUrl } from "../catalog/load.js";
import { hubApiConfigured, resolveDownloadUrl } from "../catalog/api.js";

import type { JSX, MouseEvent } from "react";

interface DownloadButtonProps {
  basePath: string;
  label: string;
  url: string;
  /** `button` is the primary action of a detail page; `ghost` sits in a card footer. */
  variant?: "button" | "ghost";
  /** When set and the API is configured, the URL is resolved by the backend. */
  assetId?: string;
  version?: string | null;
}

/**
 * A plain same-origin anchor by default: the browser saves the file and stays
 * on the page.
 *
 * In a deployment whose bucket is private, the catalogue's URL would 404, so
 * the click first asks the API for a short-lived URL. If that call fails, the
 * anchor still points at the static URL, which leaves the static deployment
 * working exactly as before.
 */
export function DownloadButton({
  basePath,
  label,
  url,
  variant = "button",
  assetId,
  version = null,
}: DownloadButtonProps): JSX.Element {
  const href = assetUrl(basePath, url);
  const filename = url.split("/").pop() ?? "download";
  const [busy, setBusy] = useState(false);
  const viaApi = hubApiConfigured && Boolean(assetId);

  async function resolveAndGo(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
    event.stopPropagation();
    if (!viaApi || !assetId) return;
    event.preventDefault();
    setBusy(true);
    try {
      const target = await resolveDownloadUrl(assetId, version);
      window.location.assign(target);
    } catch {
      window.location.assign(href);
    } finally {
      setBusy(false);
    }
  }

  return (
    <a
      aria-busy={busy}
      className={`button${variant === "ghost" ? " button-ghost" : ""}`}
      download={filename}
      href={href}
      onClick={(event) => { void resolveAndGo(event); }}
    >
      {variant === "ghost" ? <DownloadIcon size={15} /> : null}
      {label}
    </a>
  );
}
