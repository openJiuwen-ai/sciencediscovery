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
  CreateProjectRequest,
  CreateProjectResponse,
  DeletionImpact,
  Project,
  RuntimeSettingsDetails,
  RuntimeSettingsOverrides,
  UpdateProjectRequest,
} from "@sciencediscovery/schema";

import { AuthApiClient } from "./auth.js";

export class ProjectsApiClient extends AuthApiClient {
  listProjects(): Promise<Project[]> {
    return this.request("/api/projects");
  }

  createProject(body: CreateProjectRequest): Promise<CreateProjectResponse> {
    return this.request("/api/projects", { body: JSON.stringify(body), method: "POST" });
  }

  updateProject(projectId: string, body: UpdateProjectRequest): Promise<Project> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, {
      body: JSON.stringify(body),
      method: "PATCH",
    });
  }

  getProjectSettings(projectId: string): Promise<RuntimeSettingsDetails> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/settings`);
  }

  replaceProjectSettings(projectId: string, body: RuntimeSettingsOverrides): Promise<RuntimeSettingsDetails> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  getProjectDeletionImpact(projectId: string): Promise<DeletionImpact> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/deletion-impact`);
  }

  deleteProject(projectId: string): Promise<{ deleted: string }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, {
      body: JSON.stringify({ confirmationId: projectId }),
      method: "DELETE",
    });
  }
}
