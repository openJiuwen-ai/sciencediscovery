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
  CreateSessionRequest,
  RuntimeSettingsOverrides,
} from "@sciencediscovery/schema";

import { SendIcon, StopIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

export function buildCreateSessionRequest(
  title: string,
  settingsOverrides: RuntimeSettingsOverrides = {},
): CreateSessionRequest {
  return {
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(Object.keys(settingsOverrides).length ? { settingsOverrides } : {}),
  };
}

export interface ComposerRunActionInput {
  activeSessionId: string | undefined;
  hasModel: boolean;
  message: string;
  modelsAvailable: boolean;
  runningSessionIds: ReadonlySet<string>;
  sessionArchived: boolean;
  stoppingSessionIds: ReadonlySet<string>;
}

export type ComposerNoModelReason = "no-session-model" | "no-system-models";

export interface ComposerRunAction {
  noModelReason: ComposerNoModelReason | null;
  runDisabled: boolean;
  runLabel: "Add to queue" | "Run analysis" | "Configure and continue";
  stopDisabled: boolean;
  stopVisible: boolean;
}

export function ComposerNoModelNotice({
  onOpenConfiguration,
  reason,
}: {
  onOpenConfiguration: () => void;
  reason: ComposerNoModelReason;
}) {
  const { t } = useLocale();
  return <div className="composer-model-notice" role="status">
    <span>{t(reason === "no-system-models" ? "composer.noModels" : "composer.noTaskModel")}</span>
    <button onClick={onOpenConfiguration} type="button">{t("configuration.card.open")}</button>
  </div>;
}

export function shouldShowModelConfigurationCard(
  sessionId: string | undefined,
  requestedSessionId: string | undefined,
  noModelReason: ComposerNoModelReason | null,
  sessionArchived: boolean,
  isRunning: boolean,
): boolean {
  return Boolean(sessionId && requestedSessionId === sessionId && noModelReason && !sessionArchived && !isRunning);
}

/**
 * The composer button acts on the Session that is on screen. A run belonging to
 * a different Session never disables it, which is what keeps a stuck Session
 * from locking every other one out.
 */
export function resolveComposerRunAction(input: ComposerRunActionInput): ComposerRunAction {
  const sessionId = input.activeSessionId;
  const agentRunActive = Boolean(sessionId && input.runningSessionIds.has(sessionId));
  // The composer Stop controls only the main Agent's SessionRun. Reviewer
  // checkpoints have their own Stop review control in the workspace rail.
  const stopVisible = agentRunActive;
  const noModelReason = sessionId && !input.sessionArchived && !input.hasModel
    ? input.modelsAvailable ? "no-session-model" : "no-system-models"
    : null;
  return {
    noModelReason,
    runDisabled: !sessionId || !input.message.trim() || input.sessionArchived,
    runLabel: agentRunActive ? "Add to queue" : noModelReason && input.message.trim() ? "Configure and continue" : "Run analysis",
    stopDisabled: Boolean(sessionId && input.stoppingSessionIds.has(sessionId)),
    stopVisible,
  };
}

export function ComposerRunButton({
  action,
  onStop,
}: {
  action: ComposerRunAction;
  onStop: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="composer-run-actions">
      {action.stopVisible ? (
        <button
          aria-label={t("composer.stopCurrent")}
          className="send-button stop-button"
          disabled={action.stopDisabled}
          onClick={onStop}
          type="button"
        >
          <StopIcon size={15} /> {action.stopDisabled ? t("composer.stopping") : t("composer.stop")}
        </button>
      ) : null}
      <button
        className="send-button"
        disabled={action.runDisabled}
        type="submit"
      >
        <SendIcon size={15} /> {action.runLabel === "Add to queue" ? t("composer.queue")
          : action.runLabel === "Configure and continue" ? t("composer.configureContinue") : t("composer.run")}
      </button>
    </div>
  );
}
