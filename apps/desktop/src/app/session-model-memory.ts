// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { readStoredText, writeStoredText, REMEMBERED_MODEL_STORAGE_KEY, type ReadableStorage } from "../state/storage.js";

/**
 * The model a conversation created later in this app starts from (#1205), across restarts.
 *
 * The caller remembers the last model the user picked *explicitly*; opening an existing
 * conversation reads that conversation's own model and never becomes the default for the
 * next one. The pick is written to desktop storage, so a conversation created after a
 * restart still starts from it — #1204 keeps the same shape for the permission mode.
 *
 * A remembered model that has left the catalog is dropped rather than handed to the
 * server: an id this instance can no longer run would leave a dangling selection, so the
 * caller falls back to the project/global default and the picker shows that instead.
 */
export function modelForNewConversation(remembered: string | undefined, models: readonly { id: string }[]): string | undefined {
  if (!remembered) return undefined;
  return models.some((model) => model.id === remembered) ? remembered : undefined;
}

/** The model the user last picked, restored after a restart (#1205). */
export function readRememberedModel(storage: ReadableStorage | undefined): string | undefined {
  if (!storage) return undefined;
  return readStoredText(storage, REMEMBERED_MODEL_STORAGE_KEY) ?? undefined;
}

/** Remember an explicit pick; `undefined` forgets it, for a model the catalog lost. */
export function writeRememberedModel(storage: ReadableStorage | undefined, modelId: string | undefined): void {
  if (!storage) return;
  if (modelId) writeStoredText(storage, REMEMBERED_MODEL_STORAGE_KEY, modelId);
  else storage.removeItem?.(REMEMBERED_MODEL_STORAGE_KEY);
}
