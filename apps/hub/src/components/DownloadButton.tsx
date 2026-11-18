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

import { DownloadIcon } from "./icons.js";
import { assetUrl } from "../catalog/load.js";

import type { JSX } from "react";

interface DownloadButtonProps {
  basePath: string;
  label: string;
  url: string;
  /** `button` is the primary action of a detail page; `ghost` sits in a card footer. */
  variant?: "button" | "ghost";
}

/** A plain same-origin anchor: the browser saves the file and stays on the page. */
export function DownloadButton({ basePath, label, url, variant = "button" }: DownloadButtonProps): JSX.Element {
  const href = assetUrl(basePath, url);
  const filename = url.split("/").pop() ?? "download";
  return (
    <a
      className={`button${variant === "ghost" ? " button-ghost" : ""}`}
      download={filename}
      href={href}
      onClick={(event) => event.stopPropagation()}
    >
      {variant === "ghost" ? <DownloadIcon size={15} /> : null}
      {label}
    </a>
  );
}
