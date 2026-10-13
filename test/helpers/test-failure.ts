// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * What a failed test says about its failure, as plain text that a journey
 * report or a job log can carry. Free of Playwright imports, so unit tests
 * can load it.
 */

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** Playwright colors assertion messages for a terminal; a report or a log reads them as plain text. */
export function plainText(text: string): string {
  return text.replace(ANSI_SGR, "");
}

/**
 * The first lines of an error message: the assertion's own message, the
 * matcher, and expected against received, which together say what failed.
 * Stops at the stack, which a reader of a job log does not need.
 */
export function failureHeadline(message: string, maxLines = 6, maxWidth = 300): string[] {
  const lines: string[] = [];
  for (const raw of plainText(message).split("\n")) {
    const line = raw.trimEnd();
    if (/^\s+at\s/.test(line)) break;
    if (!line.trim()) continue;
    lines.push(line.length > maxWidth ? `${line.slice(0, maxWidth)}…` : line);
    if (lines.length === maxLines) break;
  }
  return lines;
}
