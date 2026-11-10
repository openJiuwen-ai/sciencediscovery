// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

export const EVOLVE_BASELINE_LIMIT = 100_000;
export const EVOLVE_EDITABLE_LIMIT = 50;

export interface EvolveDirectionInput {
  baseline: string;
  editable: string[];
}

export function evolveBaselineFields(text: string): Array<[string, unknown]> | undefined {
  if (!text.trim() || text.length > EVOLVE_BASELINE_LIMIT) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.entries(value);
  } catch {
    return undefined;
  }
}

export function evolveFieldIsSelectable(field: string): boolean {
  return field.length > 0 && field.length <= 80;
}

const DIRECTED_COMMAND = /^\/evolve-design(?=\s|$)/u;
const DIRECTION_BLOCK = /(?:^|\n)```evolve-input\n([^\n]+)\n```$/u;

const EVOLVE_FLAGS = /^\/evolve-design(?=\s|$)(?:[ \t]+--(?:algorithm[ \t]+(?:puct|openevolve)|no-confirm|allow-direct)\b)*/u;
const ALGORITHM_FLAG = /[ \t]+--algorithm[ \t]+(puct|openevolve)\b/u;

export function evolveCommandTask(command: string): string {
  return command.trimStart().replace(EVOLVE_FLAGS, "").trim();
}

export function readEvolveAlgorithm(command: string): "puct" | "openevolve" {
  return ALGORITHM_FLAG.exec(EVOLVE_FLAGS.exec(command.trimStart())?.[0] ?? "")?.[1] === "openevolve" ? "openevolve" : "puct";
}

export function withEvolveAlgorithm(command: string, algorithm: "puct" | "openevolve"): string {
  const text = command.trimStart();
  const flags = EVOLVE_FLAGS.exec(text)?.[0];
  if (!flags) return command;
  const withAlgorithm = ALGORITHM_FLAG.test(flags)
    ? flags.replace(ALGORITHM_FLAG, " --algorithm " + algorithm)
    : flags.replace("/evolve-design", "/evolve-design --algorithm " + algorithm);
  return withAlgorithm + text.slice(flags.length);
}

export function appendEvolveDirection(command: string, direction: EvolveDirectionInput): string {
  return command.trimEnd() + "\n\n```evolve-input\n" + JSON.stringify(direction) + "\n```";
}

export function readEvolveDirection(command: string): EvolveDirectionInput | "invalid" | undefined {
  if (!DIRECTED_COMMAND.test(command.trimStart())) return undefined;
  const block = DIRECTION_BLOCK.exec(command.trimEnd());
  if (!block) return undefined;
  try {
    const { baseline, editable } = JSON.parse(block[1]!) as Partial<EvolveDirectionInput>;
    if (typeof baseline !== "string" || !Array.isArray(editable) || !editable.length
        || editable.length > EVOLVE_EDITABLE_LIMIT || new Set(editable).size !== editable.length) return "invalid";
    const fields = new Map(evolveBaselineFields(baseline));
    if (!editable.every(field => typeof field === "string" && evolveFieldIsSelectable(field) && fields.has(field))) return "invalid";
    return { baseline, editable };
  } catch {
    return "invalid";
  }
}
