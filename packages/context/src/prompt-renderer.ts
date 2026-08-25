// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ResolvedContextSection } from "./contributor.js";

export interface RenderedSystemPrompt {
  sectionIds: string[];
  systemPrompt: string;
}

export interface SystemPromptRenderer {
  render(sections: readonly ResolvedContextSection[]): RenderedSystemPrompt;
}

/** Deterministic renderer; domain formatting remains owned by Contributors. */
export class DeterministicSystemPromptRenderer implements SystemPromptRenderer {
  render(sections: readonly ResolvedContextSection[]): RenderedSystemPrompt {
    const ordered = sections.toSorted((left, right) =>
      left.priority - right.priority
      || left.contributorId.localeCompare(right.contributorId)
      || left.id.localeCompare(right.id));
    return {
      sectionIds: ordered.map((section) => section.id),
      systemPrompt: ordered.map((section) => section.content).filter(Boolean).join("\n"),
    };
  }
}
