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

import type { ChatMessage, ComposerReference, WorkbenchSearchResult } from "@sciencediscovery/schema";

import { SkillCatalog } from "../skills.js";
import { SessionStore } from "../store.js";

export async function searchWorkbench(store: SessionStore, query: string): Promise<WorkbenchSearchResult[]> {
  const needle = query.trim().toLocaleLowerCase().slice(0, 200);
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLocaleLowerCase().includes(needle));
  const results: WorkbenchSearchResult[] = [];

  for (const project of store.listProjects()) {
    if (matches(project.name)) {
      results.push({
        detail: "Project",
        id: `project:${project.id}`,
        kind: "project",
        label: project.name,
        projectId: project.id,
      });
    }
    const sessions = store.listSessions(project.id, "all");
    for (const session of sessions) {
      if (matches(session.title, project.name)) {
        results.push({
          detail: `${project.name}${session.archivedAt ? " · Archived" : ""}`,
          id: `session:${session.id}`,
          kind: "session",
          label: session.title,
          projectId: project.id,
          sessionId: session.id,
        });
      }
    }
    for (const artifact of store.listProjectArtifacts(project.id)) {
      const session = sessions.find((item) => item.id === artifact.createdInSessionId);
      if (!matches(artifact.name, artifact.title ?? "", artifact.createdInSessionTitle, project.name)) continue;
      results.push({
        detail: `${project.name} / ${session?.title ?? "Deleted Session"} · ${artifact.origin}`,
        id: `artifact:${artifact.id}`,
        kind: "artifact",
        label: artifact.name,
        path: artifact.name,
        projectId: project.id,
        ...(session ? { sessionId: session.id } : {}),
      });
    }
  }
  return results.slice(0, 250);
}

export async function resolveComposerReferences(
  references: ComposerReference[] | undefined,
  sessionId: string,
  store: SessionStore,
  skillCatalog: SkillCatalog,
): Promise<ComposerReference[]> {
  if (!references?.length) return [];
  if (references.length > 16) throw new Error("A message can contain at most 16 context references");
  const resolved: ComposerReference[] = [];
  const currentSession = store.getSession(sessionId);
  if (!currentSession) throw new Error("Session not found");
  for (const reference of references) {
    if (!reference || typeof reference.id !== "string" || typeof reference.kind !== "string") {
      throw new Error("Composer reference is malformed");
    }
    if (reference.kind === "artifact") {
      const artifact = store.getProjectArtifact(currentSession.projectId, reference.id)
        ?? (reference.path ? store.getArtifactByName(sessionId, reference.path) : undefined);
      if (!artifact) throw new Error(`Referenced Project artifact is unavailable: ${reference.path ?? reference.id}`);
      resolved.push({
        createdInSessionTitle: artifact.createdInSessionTitle,
        id: artifact.id,
        kind: "artifact",
        label: artifact.name,
        origin: artifact.origin,
        path: artifact.name,
        projectId: artifact.projectId,
        sessionId: artifact.createdInSessionId,
      });
      continue;
    }
    if (reference.kind === "session") {
      const target = store.getSession(reference.id);
      if (!target) throw new Error(`Referenced Session is unavailable: ${reference.id}`);
      resolved.push({
        id: target.id,
        kind: "session",
        label: target.title,
        projectId: target.projectId,
        sessionId: target.id,
      });
      continue;
    }
    if (reference.kind === "skill") {
      const skill = skillCatalog.get(reference.id);
      if (!skill) throw new Error(`Referenced skill is unavailable: ${reference.id}`);
      resolved.push({ id: skill.id, kind: "skill", label: skill.name });
      continue;
    }
    throw new Error(`Unsupported Composer reference kind: ${reference.kind}`);
  }

  return resolved.filter((reference, index, values) =>
    values.findIndex((candidate) => candidate.kind === reference.kind && candidate.id === reference.id) === index);
}

export function messagePromptContent(message: Pick<ChatMessage, "annotations" | "content" | "references">): string {
  if (!message.references?.length && !message.annotations?.length) return message.content;
  const lines = (message.references ?? []).map((reference) => {
    if (reference.kind === "artifact") {
      return `- Artifact: ${reference.label} (artifact_id=${reference.id}, origin=${reference.origin ?? "unknown"}, created in session ${reference.createdInSessionTitle ?? reference.sessionId ?? "unknown"}); use read_artifact to read its content`;
    }
    if (reference.kind === "session") return `- Session: ${reference.label} (id: ${reference.id})`;
    return `- Attached skill: ${reference.label} (id: ${reference.id})`;
  });
  const annotations = (message.annotations ?? []).map((annotation) => {
    const region = annotation.width !== undefined && annotation.height !== undefined
      ? `region x=${annotation.x.toFixed(4)}, y=${annotation.y.toFixed(4)}, width=${annotation.width.toFixed(4)}, height=${annotation.height.toFixed(4)}`
      : `point x=${annotation.x.toFixed(4)}, y=${annotation.y.toFixed(4)}`;
    return `- Figure annotation on ${annotation.artifactLogicalName} (version id ${annotation.artifactVersionId}), ${region}: ${annotation.note}`;
  });
  return `${message.content}\n\nStructured context references:\n${[...lines, ...annotations].join("\n")}`;
}
