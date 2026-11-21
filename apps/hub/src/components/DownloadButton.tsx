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
import { downloadContentPath, hubApiConfigured, resolveDownload } from "../catalog/api.js";

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
  /** Name offered in the save dialog; defaults to the catalogue file name. */
  suggestedName?: string;
}

/**
 * Downloads the artifact.
 *
 * Two things can change the click:
 *
 * - A deployment whose bucket is private serves no static URL, so the click
 *   first asks the API for a short-lived one.
 * - Where the browser has a save dialog (`showSaveFilePicker`, Chrome and
 *   Edge), the file goes through it so the person picks the folder and name.
 *   The dialog is opened while the click is still a user gesture; resolving a
 *   URL afterwards does not need one.
 *
 * Without that API, or when the person cancels the dialog, the anchor's normal
 * download behaviour is the fallback.
 */
export function DownloadButton({
  basePath,
  label,
  url,
  variant = "button",
  assetId,
  version = null,
  suggestedName,
}: DownloadButtonProps): JSX.Element {
  const href = assetUrl(basePath, url);
  const viaApi = hubApiConfigured && Boolean(assetId);
  // `suggestedName` describes the package the API serves (a zip); a static
  // download is the file the catalogue points at, so it keeps that name.
  const filename = viaApi && suggestedName ? suggestedName : url.split("/").pop() ?? "download";
  const [busy, setBusy] = useState(false);
  const canPick = typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";

  async function startDownload(event: MouseEvent<HTMLAnchorElement>): Promise<void> {
    event.stopPropagation();
    if (!canPick && !viaApi) return; // the anchor handles a plain download
    event.preventDefault();
    setBusy(true);
    let target = href;
    try {
      if (canPick) {
        const picker = window.showSaveFilePicker;
        if (!picker) throw new Error("no save dialog");
        const handle = await picker({ suggestedName: filename });
        // Same-origin, so the page may read the bytes for the file handle
        // without a bucket CORS rule.
        target = viaApi && assetId ? downloadContentPath(assetId, version) : href;
        const response = await fetch(target);
        if (!response.ok || !response.body) throw new Error(String(response.status));
        await response.body.pipeTo(await handle.createWritable());
        return;
      }
      if (viaApi && assetId) {
        target = (await resolveDownload(assetId, version)).url;
      }
      window.location.assign(target);
    } catch (error) {
      // A cancelled dialog is not an error; anything else (an expired URL, a
      // bucket without CORS) falls back to the browser's own download.
      if (error instanceof DOMException && error.name === "AbortError") return;
      window.location.assign(target);
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
      onClick={(event) => { void startDownload(event); }}
    >
      {variant === "ghost" ? <DownloadIcon size={15} /> : null}
      {label}
    </a>
  );
}
