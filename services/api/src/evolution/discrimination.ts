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
 * Does this scoring function have any ordering power at all?
 *
 * Score the starting point, then score a copy of it that has been deliberately
 * made worse. If the two come back the same, the scorecard cannot tell a good
 * candidate from a bad one — and a search on flat terrain is a random walk that
 * looks completely normal from the outside. Every event is emitted, every
 * candidate is recorded, nothing is refused, and the dashboard shows a search
 * that simply never found anything.
 *
 * That is why this check is worth more than the others in the pre-flight set: a
 * wrong scale makes the engine throw, a wrong direction is caught by the
 * normalisation table, but zero discrimination fails **silently**. It was
 * observed on the first real judged run — a rubric that rewarded "checkable
 * specifics" gave full marks to four candidates in a row, so the tree had no
 * signal after the first expansion.
 *
 * The probe costs one extra evaluation of each of two candidates. A search
 * costs a model call and a sandboxed execution per expansion, times the budget.
 */

/**
 * Proof that a scorecard was probed and passed.
 *
 * Handed out by the probe and required by run creation. Without it the check
 * is advice: a client that skips it gets a search on flat terrain, and the
 * control plane cannot tell — re-running the probe at creation would spend the
 * same money twice.
 *
 * Keyed by the scorecard's hash, so editing the scoring after probing it
 * invalidates the proof. That is the whole point: the thing that was measured
 * has to be the thing that runs.
 */
export class ProbeRegistry {
  private readonly passed = new Map<string, number>();

  /** In-memory and short-lived on purpose: a pass that outlived the process
   *  would outlive the dataset it was taken against. */
  private static readonly TTL_MS = 60 * 60_000;

  record(scorecardHash: string, now = Date.now()): void {
    this.passed.set(scorecardHash, now);
  }

  has(scorecardHash: string, now = Date.now()): boolean {
    const at = this.passed.get(scorecardHash);
    if (at === undefined) return false;
    if (now - at > ProbeRegistry.TTL_MS) {
      this.passed.delete(scorecardHash);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.passed.size;
  }
}

export interface Damage {
  /** What was broken, for the message when the probe fails. */
  label: string;
  worsen: (source: string) => string;
}

/**
 * Ways to make a candidate worse that any real scorer should notice.
 *
 * Deliberately crude: the point is not to be subtle, it is to be *obviously*
 * worse. A scorecard that cannot separate a program from the same program with
 * its predictions shuffled is not going to separate two real candidates.
 */
export const DAMAGES: Damage[] = [
  {
    label: "把返回值换成常数",
    // A predictor that ignores its input is the floor of the task.
    worsen: (source) => `${source}\n\n_ORIGINAL_train_and_predict = train_and_predict\n\n\n`
      + "def train_and_predict(train_path, test_path):\n"
      + "    rows = _ORIGINAL_train_and_predict(train_path, test_path)\n"
      + "    return [0.0 for _ in rows]\n",
  },
  {
    label: "把顺序打乱",
    worsen: (source) => `${source}\n\n_UNSHUFFLED_train_and_predict = train_and_predict\n\n\n`
      + "def train_and_predict(train_path, test_path):\n"
      + "    rows = list(_UNSHUFFLED_train_and_predict(train_path, test_path))\n"
      + "    return rows[::-1]\n",
  },
];

/** A text candidate cannot be damaged by rewriting code; making it shorter and
 *  vaguer is the equivalent, and any rubric worth running notices. */
export const TEXT_DAMAGE: Damage = {
  label: "换成一段空话",
  worsen: () => "本工作做了一些事情，取得了一些结果，具有一定的意义。",
};

export interface ProbeResult {
  baseline: number | null;
  /** `true` when the two scored the same — the case that must refuse a run. */
  flat: boolean;
  label: string;
  worsened: number | null;
}

/**
 * Compare the starting point with a deliberately worse copy.
 *
 * `score` returns `null` when a candidate could not be scored at all, which is
 * not the same as scoring badly: a damaged copy that fails to run tells us
 * nothing about discrimination, so it is reported rather than counted as a
 * pass. The baseline failing is a different and worse problem, and the caller
 * refuses the run for it either way.
 */
export async function probeDiscrimination(input: {
  baseline: string;
  damage: Damage;
  score: (candidate: string) => Promise<number | null>;
  /** How close two scores may be and still count as the same. Judged scorers
   *  are noisy, so an exact-equality test would pass a scorecard that is flat
   *  in every way that matters. */
  tolerance?: number;
}): Promise<ProbeResult> {
  const tolerance = input.tolerance ?? 1e-6;
  const baseline = await input.score(input.baseline);
  const worsened = await input.score(input.damage.worsen(input.baseline));

  const flat = baseline !== null
    && worsened !== null
    && Math.abs(baseline - worsened) <= tolerance;
  return { baseline, flat, label: input.damage.label, worsened };
}

/** The message a refused run carries. Names both numbers, because "the scoring
 *  has no ordering power" is hard to believe without them. */
export function flatMessage(result: ProbeResult): string {
  return `把起点${result.label}之后，评分仍然是 ${result.worsened?.toFixed(4)}`
    + `（原来 ${result.baseline?.toFixed(4)}）。这套评分分不出好坏，`
    + "搜索会在完全平坦的地形上随机游走，而看板上什么都不会显示为异常";
}
