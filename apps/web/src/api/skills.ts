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

import type {
  CreateSkillRequest,
  CreateSkillDialogueDraftRequest,
  CommitSkillLibraryVersionRequest,
  CommitSkillLibraryVersionResult,
  DistillSessionSkillRequest,
  ImportSkillFromGitRequest,
  RollbackSkillLibraryVersionRequest,
  SkillDeletionImpact,
  SkillDescriptor,
  SkillDraft,
  SkillDetail,
  SkillLibrary,
  SkillLibraryDiff,
  SkillLibrarySearchRequest,
  SkillLibrarySearchResult,
  SkillLibraryVersion,
  SkillResourceContent,
  UpdateSkillRequest,
} from "@sciencediscovery/schema";

import { SettingsApiClient } from "./settings.js";

export class SkillsApiClient extends SettingsApiClient {
  listSkills(): Promise<SkillDescriptor[]> {
    return this.request("/api/skills");
  }

  listSkillLibraries(): Promise<SkillLibrary[]> {
    return this.request("/api/skill-libraries");
  }

  createSkillLibrary(body: { id?: string; name?: string } = {}): Promise<SkillLibrary> {
    return this.request("/api/skill-libraries", { body: JSON.stringify(body), method: "POST" });
  }

  searchSkillLibraries(body: SkillLibrarySearchRequest): Promise<SkillLibrarySearchResult> {
    return this.request("/api/skill-libraries/search", { body: JSON.stringify(body), method: "POST" });
  }

  getSkillLibrary(libraryId: string): Promise<SkillLibrary> {
    return this.request(`/api/skill-libraries/${encodeURIComponent(libraryId)}`);
  }

  listSkillLibraryVersions(libraryId: string): Promise<SkillLibraryVersion[]> {
    return this.request(`/api/skill-libraries/${encodeURIComponent(libraryId)}/versions`);
  }

  commitSkillLibraryVersion(
    libraryId: string,
    body: CommitSkillLibraryVersionRequest,
  ): Promise<CommitSkillLibraryVersionResult> {
    return this.request(`/api/skill-libraries/${encodeURIComponent(libraryId)}/versions`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  getSkillLibraryVersion(libraryId: string, versionId: string): Promise<SkillLibraryVersion> {
    return this.request(
      `/api/skill-libraries/${encodeURIComponent(libraryId)}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  diffSkillLibraryVersions(libraryId: string, fromVersionId: string, toVersionId: string): Promise<SkillLibraryDiff> {
    return this.request([
      `/api/skill-libraries/${encodeURIComponent(libraryId)}`,
      `/versions/${encodeURIComponent(fromVersionId)}`,
      `/diff/${encodeURIComponent(toVersionId)}`,
    ].join(""));
  }

  rollbackSkillLibrary(
    libraryId: string,
    body: RollbackSkillLibraryVersionRequest,
  ): Promise<CommitSkillLibraryVersionResult> {
    return this.request(`/api/skill-libraries/${encodeURIComponent(libraryId)}/rollback`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  getSkill(skillId: string): Promise<SkillDetail> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}`);
  }

  createSkill(body: CreateSkillRequest): Promise<SkillDetail> {
    return this.request("/api/skills", { body: JSON.stringify(body), method: "POST" });
  }

  updateSkill(skillId: string, body: UpdateSkillRequest): Promise<SkillDetail> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  importSkill(file: File): Promise<SkillDetail> {
    const body = new FormData();
    body.set("file", file);
    return this.request("/api/skills/import", { body, method: "POST" });
  }

  importSkillFromGit(body: ImportSkillFromGitRequest): Promise<SkillDetail> {
    return this.request("/api/skills/import-git", { body: JSON.stringify(body), method: "POST" });
  }

  createSkillDialogueDraft(body: CreateSkillDialogueDraftRequest): Promise<SkillDraft> {
    return this.request("/api/skills/drafts/dialogue", { body: JSON.stringify(body), method: "POST" });
  }

  distillSessionSkill(sessionId: string, body: DistillSessionSkillRequest = {}): Promise<SkillDraft> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/skills/distill`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  getSkillDeletionImpact(skillId: string): Promise<SkillDeletionImpact> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}/deletion-impact`);
  }

  deleteSkill(skillId: string): Promise<{ deleted: string }> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
  }

  readSkillResource(skillId: string, path: string): Promise<SkillResourceContent> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}/resources/${encodeURIComponent(path)}`);
  }
}
