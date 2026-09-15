// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

/**
 * Minimal OpenAI-compatible embeddings client for the knowledge engine
 * (entity embeddings, growth scoring). The control plane has no embedding
 * infrastructure of its own; this client talks to any /v1/embeddings
 * endpoint configured for the subsystem.
 */

export interface EmbeddingClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly requestTimeoutMs?: number;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;

export class EmbeddingClient {
  private readonly config: Required<Omit<EmbeddingClientConfig, never>>;

  constructor(config: EmbeddingClientConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /** Embed texts in order; result[i] corresponds to texts[i]. */
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += this.config.batchSize) {
      const batch = texts.slice(offset, offset + this.config.batchSize);
      const embeddings = await this.embedBatch(batch, signal);
      results.push(...embeddings);
    }
    return results;
  }

  async embedOne(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const [embedding] = await this.embed([text], signal);
    if (!embedding) {
      throw new Error("embedding endpoint returned no vector");
    }
    return embedding;
  }

  private async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.request(texts, signal);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.config.maxRetries) {
          break;
        }
        await sleep(500 * 2 ** attempt, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async request(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model, input: [...texts] }),
      signal: combined,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`embedding request failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
      (error as { statusCode?: number }).statusCode = response.status;
      throw error;
    }
    const payload = (await response.json().catch((error: unknown) => {
      throw contractError(`embedding endpoint returned invalid JSON: ${String(error)}`);
    })) as EmbeddingsResponse;
    const data = payload.data ?? [];
    if (data.length !== texts.length) {
      throw contractError(`embedding endpoint returned ${data.length} vectors for ${texts.length} inputs`);
    }
    return data.map((entry) => {
      if (!entry.embedding || entry.embedding.length === 0) {
        throw contractError("embedding endpoint returned an empty vector");
      }
      return new Float32Array(entry.embedding);
    });
  }
}

/** Contract violations (HTTP 200 with a broken body) must not be retried. */
function contractError(message: string): Error {
  const error = new Error(message);
  (error as { nonRetryable?: boolean }).nonRetryable = true;
  return error;
}

function isRetryable(error: unknown): boolean {
  if ((error as { nonRetryable?: boolean })?.nonRetryable) {
    return false;
  }
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === undefined) {
    return true; // network-level failure
  }
  return statusCode === 429 || statusCode >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
