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

import {
  FEEDBACK_IMAGE_MIME_TYPES,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_IMAGE_NAME,
  FEEDBACK_MAX_IMAGES,
  type FeedbackImage,
  type FeedbackImageMime,
} from "@sciencediscovery/operational-logging/feedback";

/** `accept` for the hidden file input — keep in sync with the Worker allowlist. */
export const FEEDBACK_IMAGE_ACCEPT = FEEDBACK_IMAGE_MIME_TYPES.join(",");

export type ImagePrepareError = "type" | "decode" | "size";

export type ImagePrepareResult =
  | { ok: true; image: FeedbackImage }
  | { ok: false; error: ImagePrepareError };

/** Largest edge and encoder quality, tried in order until the result fits.
 *  Retrying with a lower quality first keeps detail; shrinking is the fallback. */
const ATTEMPTS: Array<{ maxEdge: number; quality: number }> = [
  { maxEdge: 1600, quality: 0.8 },
  { maxEdge: 1600, quality: 0.6 },
  { maxEdge: 1200, quality: 0.7 },
  { maxEdge: 900, quality: 0.75 },
];

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // `readAsDataURL` always yields `data:<mime>;base64,<payload>`; the
      // payload is what the contract carries, and the Worker re-adds nothing.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode, downscale and re-encode one picked file. Everything happens in the
 * renderer: the original never leaves the machine and the payload stays inside
 * the Worker's per-image budget.
 */
export async function prepareFeedbackImage(
  file: File,
): Promise<ImagePrepareResult> {
  if (!FEEDBACK_IMAGE_MIME_TYPES.includes(file.type as FeedbackImageMime)) return { ok: false, error: "type" };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, error: "decode" };
  }

  try {
    let encoded: Blob | undefined;
    for (const attempt of ATTEMPTS) {
      const scale = Math.min(1, attempt.maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, error: "decode" };
      // Screenshots may carry transparency; flatten onto white so a JPEG
      // fallback does not turn transparent pixels black.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, "image/webp", attempt.quality)
        ?? await canvasToBlob(canvas, "image/jpeg", attempt.quality);
      if (!blob) return { ok: false, error: "decode" };
      encoded = blob;
      if (blob.size <= FEEDBACK_MAX_IMAGE_BYTES) break;
    }
    if (!encoded || encoded.size > FEEDBACK_MAX_IMAGE_BYTES) return { ok: false, error: "size" };

    const mime: FeedbackImageMime = encoded.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    return {
      ok: true,
      image: {
        name: (file.name || "image").slice(0, FEEDBACK_MAX_IMAGE_NAME),
        mime,
        data: await blobToBase64(encoded),
      },
    };
  } catch {
    return { ok: false, error: "decode" };
  } finally {
    bitmap.close();
  }
}

/** Attach as many files as there is room for; stops at the first failure so the
 *  dialog can show the reason instead of silently dropping the rest. Picks left
 *  over once the cap is reached are counted in `skipped` — one multi-select is
 *  reported as a whole, and none of them is decoded — so the dialog can say how
 *  many files it could not attach. */
export async function prepareFeedbackImages(
  files: File[],
  current: FeedbackImage[],
): Promise<{ images: FeedbackImage[]; error?: ImagePrepareError; skipped: number }> {
  const images = [...current];
  for (const [index, file] of files.entries()) {
    if (images.length >= FEEDBACK_MAX_IMAGES) return { images, skipped: files.length - index };
    const result = await prepareFeedbackImage(file);
    if (!result.ok) return { images, error: result.error, skipped: 0 };
    images.push(result.image);
  }
  return { images, skipped: 0 };
}
