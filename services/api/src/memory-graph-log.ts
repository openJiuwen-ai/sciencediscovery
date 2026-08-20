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
 * Logger for the Node-API side of the memory graph.
 *
 * Writes to ``<data-dir>/logs/memory-graph.log`` and shares that category with
 * the Python sidecar. The operational logger keeps writes best-effort,
 * redacted, level-filtered, and size-rotated.
 */

import { createOperationalLogger, type OperationalLogger } from "@sciencediscovery/operational-logging";

// The on/off switch moved out of env into the store (System Settings → Memory
// graph). The API boot wires the live toggle here via ``setToggle``; until
// then, log nothing (the toggle is read on each write, so flipping it in the
// UI takes effect immediately — no restart).
let toggle: () => boolean = () => false;

function isDisabled(): boolean {
  // When the memory graph is disabled, suppress logging entirely — neither
  // disk nor stderr should fill with skip lines for a feature the user turned
  // off.
  return !toggle();
}

let logger: OperationalLogger | undefined;

function write(level: "debug" | "info" | "warn" | "error", message: string): void {
  if (isDisabled() || !logger) return;
  logger[level]("memory_graph", { message });
}

export const mgLog = {
  /** Set the runtime data directory once at API boot. */
  setDataDir(dataDir: string): void {
    logger = createOperationalLogger({
      category: "memory-graph",
      dataDir,
      env: {
        ...process.env,
        SCIENCE_AGENT_LOG_LEVEL: process.env.SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL
          ?? process.env.SCIENCE_AGENT_LOG_LEVEL,
      },
      service: "api",
    });
  },
  /** Wire the live System Settings toggle (called once at API boot, after the
   *  store is ready). Reads on each write so a UI toggle flip applies live. */
  setToggle(isEnabled: () => boolean): void {
    toggle = isEnabled;
  },
  debug: (msg: string, ...rest: unknown[]): void => write("debug", format(msg, rest)),
  info: (msg: string, ...rest: unknown[]): void => write("info", format(msg, rest)),
  warn: (msg: string, ...rest: unknown[]): void => write("warn", format(msg, rest)),
  error: (msg: string, ...rest: unknown[]): void => write("error", format(msg, rest)),
};

function format(msg: string, rest: unknown[]): string {
  if (rest.length === 0) return msg;
  // Simple printf-style: %s / %d / %j substitution, mirroring the Python side.
  let i = 0;
  return msg.replace(/%[sdj]/g, (m) => {
    if (i >= rest.length) return m;
    const v = rest[i++];
    if (m === "%s") return String(v);
    if (m === "%d") return String(Number(v));
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}
