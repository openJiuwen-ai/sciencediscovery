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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LoaderCircle, Trash2 } from "lucide-react";

import type { ScientificArtifact } from "@sciencediscovery/schema";

import { useLocale } from "./i18n/index.js";

interface ArtifactLifecycleContextValue {
  armedDeleteId: string | undefined;
  busyDeleteIds: ReadonlySet<string>;
  clearDeleteConfirmation: () => void;
  concealArtifactActions: (artifactId: string) => void;
  revealedArtifactId: string | undefined;
  revealArtifactActions: (artifactId: string) => void;
  requestDelete: (artifact: ScientificArtifact) => void;
}

const ArtifactLifecycleContext = createContext<ArtifactLifecycleContextValue | undefined>(undefined);

function releasePointerFocus(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.currentTarget.blur();
}

export function ArtifactLifecycleProvider({
  children,
  onDelete,
  onError,
  resetKey,
}: {
  children: ReactNode;
  onDelete: (artifact: ScientificArtifact) => Promise<void>;
  onError: (message: string) => void;
  resetKey: string;
}): ReactNode {
  const { t } = useLocale();
  const [armedDeleteId, setArmedDeleteId] = useState<string>();
  const [busyDeleteIds, setBusyDeleteIds] = useState<ReadonlySet<string>>(() => new Set());
  const [revealedArtifactId, setRevealedArtifactId] = useState<string>();

  useEffect(() => {
    setArmedDeleteId(undefined);
    setRevealedArtifactId(undefined);
  }, [resetKey]);

  useEffect(() => {
    if (!armedDeleteId || typeof document === "undefined") return;
    const resetOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      const deleteButton = target instanceof Element
        ? target.closest<HTMLButtonElement>("[data-artifact-delete-button='true']")
        : null;
      if (deleteButton?.dataset.artifactId !== armedDeleteId) setArmedDeleteId(undefined);
    };
    const resetOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArmedDeleteId(undefined);
    };
    document.addEventListener("pointerdown", resetOnOutsidePointer, true);
    document.addEventListener("keydown", resetOnEscape);
    return () => {
      document.removeEventListener("pointerdown", resetOnOutsidePointer, true);
      document.removeEventListener("keydown", resetOnEscape);
    };
  }, [armedDeleteId]);

  async function runDelete(artifact: ScientificArtifact): Promise<void> {
    setBusyDeleteIds((current) => new Set(current).add(artifact.id));
    try {
      await onDelete(artifact);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t("app.artifactActionFailed"));
    } finally {
      setBusyDeleteIds((current) => {
        const next = new Set(current);
        next.delete(artifact.id);
        return next;
      });
    }
  }

  function requestDelete(artifact: ScientificArtifact): void {
    if (busyDeleteIds.has(artifact.id)) return;
    if (armedDeleteId !== artifact.id) {
      setArmedDeleteId(artifact.id);
      return;
    }
    setArmedDeleteId(undefined);
    void runDelete(artifact);
  }

  return <ArtifactLifecycleContext.Provider value={{
    armedDeleteId,
    busyDeleteIds,
    clearDeleteConfirmation: () => setArmedDeleteId(undefined),
    concealArtifactActions: (artifactId) => {
      setRevealedArtifactId((current) => current === artifactId ? undefined : current);
    },
    revealedArtifactId,
    revealArtifactActions: setRevealedArtifactId,
    requestDelete,
  }}>{children}</ArtifactLifecycleContext.Provider>;
}

export function ArtifactLifecycleRow({
  artifact,
  children,
}: {
  artifact: ScientificArtifact;
  children: ReactNode;
}): ReactNode {
  const context = useContext(ArtifactLifecycleContext);
  if (!context) throw new Error("ArtifactLifecycleRow must be rendered inside ArtifactLifecycleProvider");
  const actionsVisible = context.revealedArtifactId === artifact.id
    || context.armedDeleteId === artifact.id
    || context.busyDeleteIds.has(artifact.id);

  return <div
    className="artifact-tree-file-row"
    data-artifact-actions-visible={actionsVisible ? "true" : undefined}
    data-artifact-row-id={artifact.id}
    onPointerEnter={() => context.revealArtifactActions(artifact.id)}
    onPointerLeave={() => context.concealArtifactActions(artifact.id)}
  >
    {children}
    <ArtifactLifecycleControls artifact={artifact} />
  </div>;
}

export function ArtifactLifecycleControls({ artifact }: { artifact: ScientificArtifact }): ReactNode {
  const context = useContext(ArtifactLifecycleContext);
  if (!context) throw new Error("ArtifactLifecycleControls must be rendered inside ArtifactLifecycleProvider");
  const { t } = useLocale();
  const busy = context.busyDeleteIds.has(artifact.id);
  const deleteArmed = context.armedDeleteId === artifact.id;
  const deleteLabel = deleteArmed
    ? t("app.confirmDeleteArtifactNamed", { name: artifact.name })
    : t("app.deleteArtifact", { name: artifact.name });

  return <span className="artifact-tree-actions">
    <button
      aria-label={deleteLabel}
      aria-pressed={deleteArmed}
      className={deleteArmed ? "artifact-tree-action artifact-delete-action armed" : "artifact-tree-action artifact-delete-action"}
      data-artifact-delete-button="true"
      data-artifact-id={artifact.id}
      disabled={busy}
      onBlur={() => {
        if (deleteArmed) context.clearDeleteConfirmation();
      }}
      onClick={() => context.requestDelete(artifact)}
      onMouseDown={releasePointerFocus}
      title={deleteLabel}
      type="button"
    >{busy ? <LoaderCircle aria-hidden="true" className="spin" size={14} />
      : deleteArmed ? t("app.confirmDeleteArtifact") : <Trash2 aria-hidden="true" size={14} />}</button>
  </span>;
}
