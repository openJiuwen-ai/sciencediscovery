// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export class ResearchPackageDownloadStalledError extends Error {
  constructor() {
    super("Research package download stalled");
    this.name = "TimeoutError";
  }
}

const stalledDownloads = new WeakMap<Response, ResearchPackageDownloadStalledError>();

export async function readResearchPackageBlob(response: Response): Promise<Blob> {
  try {
    return await response.blob();
  } catch (reason) {
    // Chromium may surface an errored response body as a generic fetch error.
    throw stalledDownloads.get(response) ?? reason;
  }
}

/**
 * Keep a large research-package download alive while bytes continue to arrive.
 * The request header timeout is owned by the caller. This wrapper only limits
 * the time between body chunks and cancels the underlying response on a stall.
 */
export function withResearchPackageIdleTimeout(response: Response, idleTimeoutMs: number): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readWithIdleTimeout(reader, idleTimeoutMs);
        if (closed) return;
        if (result.done) {
          closed = true;
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (!closed) {
          closed = true;
          if (error instanceof ResearchPackageDownloadStalledError) stalledDownloads.set(wrappedResponse, error);
          controller.error(error);
          // Notify the consumer even if the underlying source is slow to cancel.
          void reader.cancel(error).catch(() => undefined);
        }
      }
    },
    async cancel(reason) {
      closed = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  const wrappedResponse = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  return wrappedResponse;
}

async function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ResearchPackageDownloadStalledError()), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
