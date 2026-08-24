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

/**
 * Per-criterion raw measurements, cached by (candidate, shard).
 *
 * The acceptance policy needs every criterion's raw number to decide whether a
 * constraint was violated, but the framework hands it only a scalar rate:
 * `MergeContext` carries `(successes, failures)` and `EvidenceCard` has no
 * free-form metrics field. Rather than fork the vendored data classes — which is
 * how a vendor drift starts — the evaluator records what it measured here and
 * the policy looks it up by the candidate's content hash.
 *
 * **Reads that decide a commit must use the full held-out set.** `mean()` averages
 * whichever shards it is given, so a caller deciding a merge passes the held-out
 * shard ids explicitly; ranking may use whatever is cheap. Conflating the two is
 * a bug this repository has already shipped once, in the regression guard.
 */

export type Measurements = Readonly<Record<string, number>>;

export interface MeasurementKey {
  /** CAS hash of the candidate's source — content, not identity, so a
   *  re-proposed identical candidate hits the same entry. */
  candidateHash: string;
  shard: string;
}

/** Default cap. A 500-candidate run over 12 shards is 6k small objects, which is
 *  fine; the cap exists because the process outlives any single run, and an
 *  unbounded map would hold every candidate of every run for the day. */
const DEFAULT_MAX_ENTRIES = 20_000;

export class MeasurementCache {
  private readonly entries = new Map<string, Measurements>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(maxEntries, 1);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Record one candidate's numbers on one shard. Re-recording overwrites: a
   *  re-execution is the newer truth, not a second opinion. */
  record(key: MeasurementKey, values: Measurements): void {
    const id = cacheKey(key);
    if (!this.entries.has(id) && this.entries.size >= this.maxEntries) {
      // Insertion-ordered map, so the oldest key is the first one out. FIFO
      // rather than LRU on purpose: a search moves forward, so recency and
      // insertion order agree and FIFO costs nothing to maintain.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(id, { ...values });
  }

  get(key: MeasurementKey): Measurements | undefined {
    return this.entries.get(cacheKey(key));
  }

  /** Which shards this candidate has been measured on. */
  shards(candidateHash: string): string[] {
    const prefix = keyPrefix(candidateHash);
    const found: string[] = [];
    for (const id of this.entries.keys()) {
      if (id.startsWith(prefix)) found.push(id.slice(prefix.length));
    }
    return found.sort();
  }

  /**
   * Mean of each criterion across shards.
   *
   * `shards` narrows to a specific set — pass the held-out ids when the answer
   * decides a merge. A criterion missing from one shard is skipped for that
   * shard rather than counted as zero: a missing measurement is unknown, and
   * averaging it in as 0 would quietly turn a gap into a bad score.
   */
  mean(candidateHash: string, shards?: readonly string[]): Measurements | undefined {
    const wanted = shards ?? this.shards(candidateHash);
    const sums = new Map<string, { count: number; total: number }>();
    let seen = 0;
    for (const shard of wanted) {
      const values = this.get({ candidateHash, shard });
      if (!values) continue;
      seen += 1;
      for (const [criterionId, value] of Object.entries(values)) {
        if (!Number.isFinite(value)) continue;
        const entry = sums.get(criterionId) ?? { count: 0, total: 0 };
        entry.count += 1;
        entry.total += value;
        sums.set(criterionId, entry);
      }
    }
    if (!seen) return undefined;
    const mean: Record<string, number> = {};
    for (const [criterionId, entry] of sums) mean[criterionId] = entry.total / entry.count;
    return mean;
  }

  /** Drop everything for one candidate. */
  forget(candidateHash: string): void {
    const prefix = keyPrefix(candidateHash);
    for (const id of [...this.entries.keys()]) {
      if (id.startsWith(prefix)) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Length-prefixed rather than separated by a delimiter.
 *
 * Shard ids are caller-supplied strings, so any separator character could also
 * appear inside one, and `hash + sep + shard` would then let two different pairs
 * produce the same key. The length prefix has no such character to collide with.
 */
function keyPrefix(candidateHash: string): string {
  return `${candidateHash.length}:${candidateHash}`;
}

function cacheKey(key: MeasurementKey): string {
  return `${keyPrefix(key.candidateHash)}${key.shard}`;
}
