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
 * Brute-force cosine similarity scan over in-memory embeddings.
 *
 * The knowledge engine's graphs top out around ~7k entities (measured on the
 * DeepAnalyze deployment), i.e. ~7M multiply-adds per query — milliseconds in
 * plain TypeScript. An ANN index (sqlite-vec HNSW) is a documented later
 * optimization; until then this deterministic scan is the reference
 * implementation and its results define what any index must reproduce.
 */

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const va = a[index] ?? 0;
    const vb = b[index] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbeddingItem<T> {
  readonly item: T;
  readonly embedding: ArrayLike<number>;
}

export interface CosineMatch<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Rank items by cosine similarity to the query embedding. Items with no
 * embedding are skipped by the caller (pass only embedded items). Results are
 * sorted by score desc; equal scores preserve input order (stable sort) so
 * results are deterministic for a fixed input order.
 */
export function cosineScan<T>(
  query: ArrayLike<number>,
  items: ReadonlyArray<EmbeddingItem<T>>,
  options: { threshold?: number; topK?: number } = {},
): Array<CosineMatch<T>> {
  const threshold = options.threshold ?? Number.NEGATIVE_INFINITY;
  const scored: Array<CosineMatch<T>> = [];
  for (const { item, embedding } of items) {
    const score = cosineSimilarity(query, embedding);
    if (score >= threshold) {
      scored.push({ item, score });
    }
  }
  scored.sort((left, right) => right.score - left.score);
  return options.topK === undefined ? scored : scored.slice(0, options.topK);
}

/** Serialize an embedding to an owned Float32 buffer for SQLite BLOB storage. */
export function embeddingToBlob(embedding: ArrayLike<number>): Uint8Array {
  const array = embedding instanceof Float32Array ? embedding : new Float32Array(Array.from(embedding));
  // Always copy: a view over the caller's buffer would let later mutation of
  // their array silently corrupt the bytes destined for storage.
  return new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
}

/**
 * Deserialize a Float32 BLOB produced by {@link embeddingToBlob}.
 * Accepts raw bytes only — passing a Float32Array here is a type error by
 * design (its element values are floats, not bytes).
 */
export function embeddingFromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
