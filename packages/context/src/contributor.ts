// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

export type AgentScope = "main" | "reviewer" | "subagent";

export type ContextSectionSlot =
  | "identity"
  | "governance"
  | "run_contract"
  | "task_state"
  | "capabilities"
  | "working_context"
  | "footer";

export interface ContextSection {
  content: string;
  id: string;
  order?: number;
  protected?: boolean;
  revision?: string;
  slot: ContextSectionSlot;
}

export interface ContextAttachment {
  content: string;
  id: string;
  source: string;
  trust: "trusted_data" | "untrusted_data";
}

export interface ContextDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning";
}

export interface ContextContribution<TMessage extends RuntimeMessage = RuntimeMessage> {
  attachments?: ContextAttachment[];
  diagnostics?: ContextDiagnostic[];
  messages?: TMessage[];
  systemSections?: ContextSection[];
}

export interface ContextContributionRequest<TMessage extends RuntimeMessage = RuntimeMessage> {
  contextId: string;
  history: readonly TMessage[];
  latestUserInput: string;
  scope: AgentScope;
  signal: AbortSignal;
  turn: number;
}

export interface ContextContributor<TMessage extends RuntimeMessage = RuntimeMessage> {
  readonly id: string;
  /** Required contributors fail assembly; optional contributors are omitted with a diagnostic. */
  readonly required?: boolean;
  readonly scopes: readonly AgentScope[];
  contribute(request: ContextContributionRequest<TMessage>): Promise<ContextContribution<TMessage>>;
}

export interface ContextContributorFactoryRequest {
  contextId: string;
  scope: AgentScope;
}

/** Composition-root extension seam for capability packages. */
export interface ContextContributorFactory<TMessage extends RuntimeMessage = RuntimeMessage> {
  readonly id: string;
  create(request: ContextContributorFactoryRequest):
    | ContextContributor<TMessage>
    | readonly ContextContributor<TMessage>[];
}

export const CONTEXT_SECTION_SLOT_PRIORITY: Readonly<Record<ContextSectionSlot, number>> = Object.freeze({
  identity: 100,
  governance: 200,
  run_contract: 300,
  task_state: 400,
  capabilities: 500,
  working_context: 600,
  footer: 900,
});

export interface ResolvedContextSection extends ContextSection {
  contributorId: string;
  priority: number;
}

export interface CollectedContext<TMessage extends RuntimeMessage = RuntimeMessage> {
  attachments: Array<ContextAttachment & { contributorId: string }>;
  diagnostics: Array<ContextDiagnostic & { contributorId: string }>;
  messages: TMessage[];
  sections: ResolvedContextSection[];
}

export interface ContextContributorTrace<TMessage extends RuntimeMessage = RuntimeMessage> {
  contribution?: ContextContribution<TMessage>;
  contributorId: string;
  durationMs: number;
  error?: string;
  required: boolean;
  status: "contributed" | "failed";
}

export interface ContextCollectionReport<TMessage extends RuntimeMessage = RuntimeMessage> {
  collected: CollectedContext<TMessage>;
  contributors: ContextContributorTrace<TMessage>[];
}

export class ContextCollectionError<TMessage extends RuntimeMessage = RuntimeMessage> extends Error {
  constructor(message: string, readonly report: ContextCollectionReport<TMessage>) {
    super(message);
    this.name = "ContextCollectionError";
  }
}

const CONTRIBUTOR_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const MAX_SECTION_CHARACTERS = 100_000;
const MAX_ATTACHMENT_CHARACTERS = 1_000_000;

function validateId(kind: string, id: string): void {
  if (!CONTRIBUTOR_ID.test(id)) throw new Error(`${kind} id is invalid: ${id}`);
}

function latestUserInput<TMessage extends RuntimeMessage>(history: readonly TMessage[]): string {
  const message = history.findLast((item) => item.role === "user");
  return typeof message?.content === "string" ? message.content : "";
}

/** Per-AgentRun registry. Freeze it before execution so one run has stable contributors. */
export class ContextContributorRegistry<TMessage extends RuntimeMessage = RuntimeMessage> {
  private readonly contributors = new Map<string, ContextContributor<TMessage>>();
  private frozen = false;

  register(contributor: ContextContributor<TMessage>): this {
    if (this.frozen) throw new Error("Context contributor registry is frozen");
    validateId("Contributor", contributor.id);
    if (this.contributors.has(contributor.id)) throw new Error(`Duplicate context contributor: ${contributor.id}`);
    this.contributors.set(contributor.id, contributor);
    return this;
  }

  freeze(): this {
    this.frozen = true;
    return this;
  }

  async collect(input: {
    contextId: string;
    history: readonly TMessage[];
    scope: AgentScope;
    signal: AbortSignal;
    turn: number;
  }): Promise<CollectedContext<TMessage>> {
    return (await this.collectDetailed(input)).collected;
  }

  async collectDetailed(input: {
    contextId: string;
    history: readonly TMessage[];
    scope: AgentScope;
    signal: AbortSignal;
    turn: number;
  }): Promise<ContextCollectionReport<TMessage>> {
    const active = [...this.contributors.values()]
      .filter((contributor) => contributor.scopes.includes(input.scope))
      .sort((left, right) => left.id.localeCompare(right.id));
    const request: ContextContributionRequest<TMessage> = {
      ...input,
      latestUserInput: latestUserInput(input.history),
    };
    const results = await Promise.all(active.map(async (contributor): Promise<{
      contribution?: ContextContribution<TMessage>;
      contributor: ContextContributor<TMessage>;
      trace: ContextContributorTrace<TMessage>;
    }> => {
      const startedAt = Date.now();
      try {
        const contribution = await contributor.contribute(request);
        return {
          contribution,
          contributor,
          trace: {
            contribution: structuredClone(contribution),
            contributorId: contributor.id,
            durationMs: Date.now() - startedAt,
            required: contributor.required !== false,
            status: "contributed" as const,
          },
        };
      } catch (error) {
        return {
          contributor,
          trace: {
            contributorId: contributor.id,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            required: contributor.required !== false,
            status: "failed" as const,
          },
        };
      }
    }));

    const sectionIds = new Set<string>();
    const attachmentIds = new Set<string>();
    const collected: CollectedContext<TMessage> = { attachments: [], diagnostics: [], messages: [], sections: [] };
    const fatal: string[] = [];
    for (const result of results) {
      const { contributor, trace } = result;
      let contribution = result.contribution;
      if (!contribution) {
        if (trace.required) fatal.push(`${contributor.id}: ${trace.error}`);
        else collected.diagnostics.push({
          code: "CONTRIBUTOR_FAILED",
          contributorId: contributor.id,
          message: trace.error ?? "Unknown contributor failure",
          severity: "warning",
        });
        continue;
      }
      try {
        const stagedSections: ResolvedContextSection[] = [];
        const stagedSectionIds = new Set<string>();
        for (const section of contribution.systemSections ?? []) {
          validateId("Context section", section.id);
          if (!section.content.trim()) throw new Error(`Context section is empty: ${section.id}`);
          if (section.content.length > MAX_SECTION_CHARACTERS) throw new Error(`Context section is too large: ${section.id}`);
          if (sectionIds.has(section.id) || stagedSectionIds.has(section.id)) throw new Error(`Duplicate context section: ${section.id}`);
          stagedSectionIds.add(section.id);
          stagedSections.push({
            ...section,
            contributorId: contributor.id,
            priority: CONTEXT_SECTION_SLOT_PRIORITY[section.slot] + (section.order ?? 0),
          });
        }
        const stagedAttachments: Array<ContextAttachment & { contributorId: string }> = [];
        const stagedAttachmentIds = new Set<string>();
        for (const attachment of contribution.attachments ?? []) {
          validateId("Context attachment", attachment.id);
          if (attachment.content.length > MAX_ATTACHMENT_CHARACTERS) throw new Error(`Context attachment is too large: ${attachment.id}`);
          if (attachmentIds.has(attachment.id) || stagedAttachmentIds.has(attachment.id)) throw new Error(`Duplicate context attachment: ${attachment.id}`);
          stagedAttachmentIds.add(attachment.id);
          stagedAttachments.push({ ...attachment, contributorId: contributor.id });
        }
        for (const id of stagedSectionIds) sectionIds.add(id);
        for (const id of stagedAttachmentIds) attachmentIds.add(id);
        collected.sections.push(...stagedSections);
        collected.attachments.push(...stagedAttachments);
        collected.messages.push(...(contribution.messages ?? []).map((message) => structuredClone(message)));
        collected.diagnostics.push(...(contribution.diagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          contributorId: contributor.id,
        })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.status = "failed";
        trace.error = message;
        if (trace.required) fatal.push(`${contributor.id}: ${message}`);
        else collected.diagnostics.push({
          code: "CONTRIBUTOR_FAILED",
          contributorId: contributor.id,
          message,
          severity: "warning",
        });
        contribution = undefined;
      }
    }
    collected.sections.sort((left, right) => left.priority - right.priority
      || left.contributorId.localeCompare(right.contributorId)
      || left.id.localeCompare(right.id));
    collected.attachments.sort((left, right) => left.contributorId.localeCompare(right.contributorId)
      || left.id.localeCompare(right.id));
    const report: ContextCollectionReport<TMessage> = {
      collected,
      contributors: results.map((result) => result.trace),
    };
    if (fatal.length) throw new ContextCollectionError(`Required context contributor failed: ${fatal.join("; ")}`, report);
    return report;
  }
}

export function registerContextContributorFactories<TMessage extends RuntimeMessage>(
  registry: ContextContributorRegistry<TMessage>,
  factories: readonly ContextContributorFactory<TMessage>[],
  request: ContextContributorFactoryRequest,
): ContextContributorRegistry<TMessage> {
  const ids = new Set<string>();
  for (const factory of factories) {
    validateId("Context contributor factory", factory.id);
    if (ids.has(factory.id)) throw new Error(`Duplicate context contributor factory: ${factory.id}`);
    ids.add(factory.id);
    const created = factory.create(request);
    const contributors: readonly ContextContributor<TMessage>[] = "contribute" in created ? [created] : created;
    for (const contributor of contributors) registry.register(contributor);
  }
  return registry;
}

/** Migration contributor that preserves the current complete prompt byte-for-byte. */
export class StaticSystemPromptContributor<TMessage extends RuntimeMessage = RuntimeMessage>
implements ContextContributor<TMessage> {
  readonly id = "legacy.system-prompt";
  readonly required = true;
  readonly scopes: readonly AgentScope[];

  constructor(private readonly prompt: string, scopes: readonly AgentScope[] = ["main", "subagent", "reviewer"]) {
    this.scopes = scopes;
  }

  async contribute(): Promise<ContextContribution<TMessage>> {
    return {
      systemSections: [{
        content: this.prompt,
        id: "legacy.system-prompt",
        protected: true,
        slot: "identity",
      }],
    };
  }
}

export class ContextSectionContributor<TMessage extends RuntimeMessage = RuntimeMessage>
implements ContextContributor<TMessage> {
  readonly id: string;
  readonly required: boolean;
  readonly scopes: readonly AgentScope[];

  constructor(private readonly options: {
    contribute(request: ContextContributionRequest<TMessage>): ContextContribution<TMessage> | Promise<ContextContribution<TMessage>>;
    id: string;
    required?: boolean;
    scopes?: readonly AgentScope[];
  }) {
    this.id = options.id;
    this.required = options.required ?? true;
    this.scopes = options.scopes ?? ["main", "subagent", "reviewer"];
  }

  async contribute(request: ContextContributionRequest<TMessage>): Promise<ContextContribution<TMessage>> {
    return this.options.contribute(request);
  }
}

function stringField(message: RuntimeMessage, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
}

export function loadedSkillIds(history: readonly RuntimeMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of history) {
    if (message.role !== "tool" || stringField(message, "name") !== "read_skill") continue;
    const content = stringField(message, "content") ?? "";
    const match = /^Selected skill ([a-z][a-z0-9._-]*)@/mu.exec(content);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

/** Deterministic state derived only from committed tool results. */
export class TaskStateContributor<TMessage extends RuntimeMessage = RuntimeMessage>
implements ContextContributor<TMessage> {
  readonly id = "runtime.task-state";
  readonly required = false;

  constructor(readonly scopes: readonly AgentScope[] = ["main", "subagent", "reviewer"]) {}

  async contribute(request: ContextContributionRequest<TMessage>): Promise<ContextContribution<TMessage>> {
    const loaded = [...loadedSkillIds(request.history)].sort();
    const plan = request.history.findLast((message) => (
      message.role === "tool" && stringField(message, "name") === "propose_plan"
    ));
    if (!loaded.length && !plan) return {};
    const content = [
      `<runtime_task_state turn="${request.turn}">`,
      loaded.length ? `Loaded skills: ${loaded.join(", ")}` : "Loaded skills: none",
      ...(plan ? ["Latest committed plan tool result:", stringField(plan, "content") ?? ""] : []),
      "</runtime_task_state>",
    ].join("\n");
    return { systemSections: [{ content, id: "runtime.task-state", slot: "task_state" }] };
  }
}
