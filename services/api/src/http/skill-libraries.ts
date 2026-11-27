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

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  CommitSkillLibraryVersionRequest,
  PublishSkillLibraryUpdateProposalsRequest,
  ProposeSkillLibraryUpdateRequest,
  RollbackSkillLibraryVersionRequest,
  SkillLibrarySearchRequest,
} from "@sciencediscovery/schema";

import { SkillLibraryCatalog, SkillLibraryCatalogError } from "../skill-library-catalog.js";
import { readJson } from "./body.js";
import { decodePathParameter } from "./decode-path-parameter.js";
import { sendJson } from "./response.js";

export async function handleSkillLibraryRequest(options: {
  catalog: SkillLibraryCatalog;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const { catalog, request, response, url } = options;
  if (request.method === "GET" && url.pathname === "/api/skill-libraries") {
    sendJson(response, 200, catalog.list());
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skill-libraries") {
    sendJson(response, 201, await catalog.create(await readJson<{ id?: string; name?: string }>(request)));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skill-libraries/search") {
    sendJson(response, 200, await catalog.search(await readJson<SkillLibrarySearchRequest>(request)));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/skill-library-proposals") {
    sendJson(response, 200, catalog.listProposals(url.searchParams.get("libraryId") ?? undefined));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/skill-library-proposals/publish") {
    const body = await readJson<PublishSkillLibraryUpdateProposalsRequest>(request);
    const result = await catalog.publishProposals(body.proposalIds ?? []);
    sendJson(response, result.result.conflicts.length ? 409 : 201, result);
    return true;
  }

  const proposalPublishMatch = url.pathname.match(/^\/api\/skill-library-proposals\/([^/]+)\/publish$/);
  if (proposalPublishMatch && request.method === "POST") {
    const result = await catalog.publishProposal(decodePathParameter(proposalPublishMatch[1]!, "proposal id"));
    sendJson(response, result.result.conflicts.length ? 409 : 201, result);
    return true;
  }

  const proposalRejectMatch = url.pathname.match(/^\/api\/skill-library-proposals\/([^/]+)\/reject$/);
  if (proposalRejectMatch && request.method === "POST") {
    sendJson(response, 200, await catalog.rejectProposal(decodePathParameter(proposalRejectMatch[1]!, "proposal id")));
    return true;
  }

  const skillLibrariesMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)$/);
  if (skillLibrariesMatch && request.method === "GET") {
    const libraryId = decodePathParameter(skillLibrariesMatch[1]!, "skill library id");
    const library = catalog.get(libraryId);
    if (!library) throw new SkillLibraryCatalogError("SKILL_LIBRARY_NOT_FOUND", `Skill library not found: ${libraryId}`);
    sendJson(response, 200, library);
    return true;
  }

  const skillLibraryVersionsMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)\/versions$/);
  if (skillLibraryVersionsMatch && request.method === "GET") {
    sendJson(response, 200, await catalog.listVersions(decodePathParameter(skillLibraryVersionsMatch[1]!, "skill library id")));
    return true;
  }
  if (skillLibraryVersionsMatch && request.method === "POST") {
    const result = await catalog.commitVersion(
      decodePathParameter(skillLibraryVersionsMatch[1]!, "skill library id"),
      await readJson<CommitSkillLibraryVersionRequest>(request),
    );
    sendJson(response, result.conflicts.length ? 409 : result.dryRun ? 200 : 201, result);
    return true;
  }

  const skillLibraryProposalMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)\/proposals$/);
  if (skillLibraryProposalMatch && request.method === "POST") {
    sendJson(response, 201, await catalog.proposeUpdate(
      decodePathParameter(skillLibraryProposalMatch[1]!, "skill library id"),
      await readJson<ProposeSkillLibraryUpdateRequest>(request),
    ));
    return true;
  }

  const skillLibraryVersionMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)\/versions\/([^/]+)$/);
  if (skillLibraryVersionMatch && request.method === "GET") {
    sendJson(response, 200, await catalog.getVersion(
      decodePathParameter(skillLibraryVersionMatch[1]!, "skill library id"),
      decodePathParameter(skillLibraryVersionMatch[2]!, "version id"),
    ));
    return true;
  }

  const skillLibraryVersionDiffMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)\/versions\/([^/]+)\/diff\/([^/]+)$/);
  if (skillLibraryVersionDiffMatch && request.method === "GET") {
    sendJson(response, 200, await catalog.diffVersions(
      decodePathParameter(skillLibraryVersionDiffMatch[1]!, "skill library id"),
      decodePathParameter(skillLibraryVersionDiffMatch[2]!, "version id"),
      decodePathParameter(skillLibraryVersionDiffMatch[3]!, "version id"),
    ));
    return true;
  }

  const skillLibraryRollbackMatch = url.pathname.match(/^\/api\/skill-libraries\/([^/]+)\/rollback$/);
  if (skillLibraryRollbackMatch && request.method === "POST") {
    const result = await catalog.rollback(
      decodePathParameter(skillLibraryRollbackMatch[1]!, "skill library id"),
      await readJson<RollbackSkillLibraryVersionRequest>(request),
    );
    sendJson(response, result.conflicts.length ? 409 : 201, result);
    return true;
  }

  return false;
}
