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
 * Taking a workspace file into the CAS, and telling the wizard what is in it.
 *
 * Two jobs in one call because the wizard cannot ask its next question without
 * the answer to this one: step ③ asks which column the candidate must predict,
 * and a dropdown of columns beats a free-text field that fails at staging time
 * with "the column you named is not in the file".
 *
 * The row count comes back for the same reason — the split is `shards × rows`,
 * and a user choosing 8 shards of 20 rows against a 60-row file should be told
 * so while they are choosing, not when the run refuses to start.
 */

import { readFile } from "node:fs/promises";

import type { ContentStore } from "@sciencediscovery/cas";

import { parseCsv } from "./dataset.js";

/** Above this the file is refused rather than read into memory. Same bound as
 *  staging, and for the same reason: the shards are small, the source is not. */
const MAX_BYTES = 64 * 1024 * 1024;

export interface DatasetSummary {
  cas: string;
  /** Every column, in file order — the wizard's target-column choices. */
  columns: string[];
  /** A few rows verbatim. The drafting model reads units and scale off these;
   *  a column called `y` says nothing about whether it is a price or a label. */
  head: string[][];
  /** Columns whose every sampled value parses as a number. A target that is not
   *  numeric cannot be scored by any metric this engine has, and saying so here
   *  is cheaper than finding out at staging. */
  numericColumns: string[];
  rows: number;
}

export class DatasetIntakeError extends Error {}

/** How many rows are sampled to decide whether a column is numeric. Reading all
 *  of a large file to answer a dropdown's question is not worth the wait. */
const SAMPLE = 200;

/** Rows handed to the drafting model. Enough to see units and scale, few
 *  enough that the prompt stays about the task rather than the data. */
const HEAD_ROWS = 5;

export async function ingestDataset(input: {
  cas: Pick<ContentStore, "put">;
  /** Text typed in the wizard rather than read from the workspace. A rubric and
   *  a first draft are written on the spot; making the user save a file first
   *  would be a step that exists only because this function reads files. */
  content?: string;
  path: string;
  /** Skip the CSV reading. The wizard uses the same call to take the baseline
   *  *program* into the CAS, and a `.py` has no columns to describe — parsing
   *  it would refuse a file that is perfectly fine. */
  raw?: boolean;
  resolve: (path: string) => string;
}): Promise<DatasetSummary> {
  let bytes: Buffer;
  if (input.content !== undefined) {
    bytes = Buffer.from(input.content, "utf-8");
    if (!input.content.trim()) throw new DatasetIntakeError("内容是空的");
  } else try {
    bytes = await readFile(input.resolve(input.path));
  } catch {
    // `resolve` is the workspace resolver, which already refuses to escape the
    // root; anything left is a path the user mistyped.
    throw new DatasetIntakeError(`工作区里没有 ${input.path}`);
  }
  if (bytes.length > MAX_BYTES) {
    throw new DatasetIntakeError(`${input.path} 超过 ${MAX_BYTES / 1024 / 1024}MB，暂不支持`);
  }

  if (input.raw) {
    const stored = await input.cas.put(bytes);
    return { cas: `sha256:${stored.hash}`, columns: [], head: [], numericColumns: [], rows: 0 };
  }

  const described = describeTable(bytes.toString("utf-8"), input.path);
  const stored = await input.cas.put(bytes);
  return { cas: `sha256:${stored.hash}`, ...described };
}

/**
 * What is in this table, without taking it into the store.
 *
 * Split out because the drafting agent asks the same question for a different
 * reason: it has to name a target column, and it can only do that if it has
 * seen the columns. Reading a file to answer a question is not a decision to
 * keep it, and copying every table a model glanced at into content-addressed
 * storage would fill it with files nobody chose.
 */
export function describeTable(
  csv: string, label = "这份数据",
): Omit<DatasetSummary, "cas"> {
  const table = parseCsv(csv);
  if (!table.header.length) throw new DatasetIntakeError(`${label} 没有表头`);
  if (!table.rows.length) throw new DatasetIntakeError(`${label} 只有表头，没有数据`);

  const sample = table.rows.slice(0, SAMPLE);
  const numericColumns = table.header.filter((_column, index) => sample.every((row) => {
    const value = row[index];
    return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));
  }));

  return {
    columns: table.header,
    head: table.rows.slice(0, HEAD_ROWS),
    numericColumns,
    rows: table.rows.length,
  };
}
