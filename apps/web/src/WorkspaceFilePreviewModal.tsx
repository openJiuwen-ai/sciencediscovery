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

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api.js";
import { DetailModal } from "./DetailModal.js";
import { downloadBlob } from "./artifact-download.js";
import { useLocale } from "./i18n/index.js";
import { DownloadIcon } from "./icons.js";

interface Preview {
  size: number;
  mediaType: string;
  previewBytes: number;
  truncated: boolean;
  text?: string;
  imageUrl?: string;
}

// Use a complete image, never the byte prefix intended for text previews.
function imageMediaType(path: string): string | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  };
  return types[extension];
}

/** Never execute file content. Decode UTF-8 / BOM-marked UTF-16, preserving its formatting. */
function decodeText(bytes: Uint8Array, truncated: boolean, mediaType: string): string | undefined {
  if (!bytes.length) return "";
  if (/^(image|audio|video)\//i.test(mediaType)
    || /^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed)(;|$)/i.test(mediaType)) return undefined;
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    // stream avoids replacing an incomplete final character in a truncated preview.
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 27) return undefined;
    }
    return text;
  } catch { return undefined; }
}

export function WorkspaceFilePreviewModal({ client, sessionId, path, onClose }: {
  client: ApiClient;
  sessionId: string;
  path: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const downloadController = useRef<AbortController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const fileName = path.replaceAll("\\", "/").split("/").at(-1) || path;

  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | undefined;
    setPreview(undefined);
    setError(undefined);
    void (async () => {
      try {
        const imageType = imageMediaType(path);
        if (imageType) {
          const blob = await client.readFile(sessionId, path, controller.signal);
          if (controller.signal.aborted) return;
          imageUrl = URL.createObjectURL(blob.slice(0, blob.size, imageType));
          setPreview({ size: blob.size, mediaType: imageType, previewBytes: blob.size, truncated: false, imageUrl });
          return;
        }
        const { blob, size, truncated } = await client.readFilePreview(sessionId, path, controller.signal);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = decodeText(bytes, truncated, blob.type);
        if (!controller.signal.aborted) setPreview({ size, mediaType: blob.type, previewBytes: bytes.length, truncated, text });
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("workspacePreview.loadFailed"));
      }
    })();
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [client, sessionId, path, attempt, t]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const section = container.current?.querySelector<HTMLElement>('[role="dialog"]');
    document.body.style.overflow = "hidden";
    section?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab" || !section) return;
      const items = [...section.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (!section.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      downloadController.current?.abort();
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  async function download(): Promise<void> {
    if (downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const blob = await client.readFile(sessionId, path, controller.signal);
      if (!controller.signal.aborted) downloadBlob(blob, fileName);
    } catch (reason) {
      if (!controller.signal.aborted) setDownloadError(reason instanceof Error ? reason.message : t("workspacePreview.downloadFailed"));
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
      if (downloadController.current === controller) downloadController.current = undefined;
    }
  }

  return <div className="workspace-file-preview-modal" ref={container}>
    <DetailModal eyebrow={t("workspacePreview.title")} title={fileName} onClose={onClose} controls={
      <button className="icon-button workspace-preview-download" aria-label={t(downloading ? "workspacePreview.downloading" : "workspacePreview.download")} title={t(downloading ? "workspacePreview.downloading" : "workspacePreview.download")} aria-busy={downloading} disabled={downloading} onClick={() => void download()} type="button"><DownloadIcon size={18} /></button>
    }>
      <div className="workspace-file-preview">
        <p className="workspace-preview-path"><strong>{t("workspaceProvenance.path")}: </strong><code>{path}</code></p>
        {preview ? <p className="muted">{t("workspaceProvenance.size")}: {preview.size.toLocaleString()} B · {preview.mediaType || "application/octet-stream"}</p> : null}
        {!preview && !error ? <p role="status">{t("workspacePreview.loading")}</p> : null}
        {error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt((value) => value + 1)} type="button">{t("workspacePreview.retry")}</button></div> : null}
        {downloadError ? <p className="workspace-preview-error" role="alert">{downloadError}</p> : null}
        {preview?.truncated ? <p className="workspace-preview-notice" role="note">{t("workspacePreview.truncated", { bytes: preview.previewBytes.toLocaleString() })}</p> : null}
        {preview?.text === "" ? <p role="status">{t("workspacePreview.empty")}</p> : null}
        {preview?.text ? <pre className="workspace-preview-code" tabIndex={0} aria-label={t("workspacePreview.content")}><code>{preview.text}</code></pre> : null}
        {preview?.imageUrl && !error ? <div className="workspace-preview-image"><img src={preview.imageUrl} alt={fileName} onError={() => setError(t("workspacePreview.loadFailed"))} /></div> : null}
        {preview && preview.text === undefined && !preview.imageUrl ? <p role="note">{t("workspacePreview.binary")}</p> : null}
      </div>
    </DetailModal>
  </div>;
}
