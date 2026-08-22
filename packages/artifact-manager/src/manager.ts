// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  classifyScientificArtifact,
  type ArtifactOrigin,
  type ArtifactOriginMeta,
  type CasObjectRef,
  type ComposerReference,
  type ScientificArtifact,
  type ScientificArtifactKind,
  type ScientificArtifactVersion,
} from "@sciencediscovery/schema";

export interface ArtifactVersionInput {
  content: CasObjectRef;
  description?: string;
  executionRunIds?: string[];
  inputArtifactVersionIds?: string[];
  kind: ScientificArtifactKind;
  logicalName: string;
  mediaType: string;
  origin: ArtifactOrigin;
  originMeta?: ArtifactOriginMeta;
  references?: ComposerReference[];
  sessionId: string;
  sourcePath?: string;
  title?: string;
  turnId?: string;
}

export interface ArtifactCatalogPort {
  createVersion(input: ArtifactVersionInput): Promise<{
    artifact: ScientificArtifact;
    version: ScientificArtifactVersion;
  }>;
}

export interface ArtifactContentPort {
  putWorkspaceFile(workspaceRoot: string, path: string): Promise<CasObjectRef>;
}

export interface RegisterWorkspaceArtifactInput {
  description?: string;
  executionRunIds?: string[];
  inputArtifactVersionIds?: string[];
  kind?: ScientificArtifactKind;
  logicalName?: string;
  origin?: ArtifactOrigin;
  originMeta?: ArtifactOriginMeta;
  path: string;
  references?: ComposerReference[];
  sessionId: string;
  sourcePath?: string;
  title?: string;
  turnId?: string;
  workspaceRoot: string;
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".cif": "chemical/x-cif", ".csv": "text/csv", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".feather": "application/vnd.apache.arrow.file", ".htm": "text/html", ".html": "text/html",
  ".ipynb": "application/x-ipynb+json", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json",
  ".md": "text/markdown", ".markdown": "text/markdown", ".mmcif": "chemical/x-mmcif", ".mol2": "chemical/x-mol2",
  ".parquet": "application/vnd.apache.parquet", ".pdb": "chemical/x-pdb", ".pdf": "application/pdf", ".png": "image/png",
  ".sdf": "chemical/x-mdl-sdfile", ".svg": "image/svg+xml", ".tex": "application/x-tex", ".tsv": "text/tab-separated-values",
  ".webp": "image/webp", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xyz": "chemical/x-xyz",
};

function extension(path: string): string {
  const tail = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = tail.lastIndexOf(".");
  return dot > 0 ? tail.slice(dot).toLocaleLowerCase() : "";
}

export function artifactMediaType(path: string): string {
  return MEDIA_TYPES[extension(path)] ?? "application/octet-stream";
}

/** Domain entry point shared by Agent declaration, download, upload and Executor adapters. */
export class ArtifactManager {
  constructor(
    private readonly content: ArtifactContentPort,
    private readonly catalog: ArtifactCatalogPort,
  ) {}

  async registerWorkspaceArtifact(input: RegisterWorkspaceArtifactInput): Promise<{
    artifact: ScientificArtifact;
    version: ScientificArtifactVersion;
  }> {
    const content = await this.content.putWorkspaceFile(input.workspaceRoot, input.path);
    return await this.catalog.createVersion({
      content,
      ...(input.description ? { description: input.description } : {}),
      executionRunIds: input.executionRunIds,
      inputArtifactVersionIds: input.inputArtifactVersionIds,
      kind: input.kind ?? classifyScientificArtifact(input.path) ?? "other",
      logicalName: input.logicalName ?? input.path,
      mediaType: artifactMediaType(input.path),
      origin: input.origin ?? "user_upload",
      ...(input.originMeta ? { originMeta: input.originMeta } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      sessionId: input.sessionId,
      sourcePath: input.sourcePath ?? input.path,
      ...(input.title ? { title: input.title } : {}),
      turnId: input.turnId,
    });
  }
}
