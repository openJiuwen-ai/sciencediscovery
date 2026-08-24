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
  reviewerCheckpointRunning: boolean;
  runningSessionIds: ReadonlySet<string>;
  sessionArchived: boolean;
  stoppingSessionIds: ReadonlySet<string>;
}

export type ComposerNoModelReason = "no-session-model" | "no-system-models";

export interface ComposerRunAction {
  noModelReason: ComposerNoModelReason | null;
  runDisabled: boolean;
  runLabel: "Add to queue" | "Run analysis";
  stopDisabled: boolean;
  stopVisible: boolean;
}

const COMPOSER_NO_MODEL_NOTICE_ID = "composer-no-model-notice";

/**
 * The composer button acts on the Session that is on screen. A run belonging to
 * a different Session never disables it, which is what keeps a stuck Session
 * from locking every other one out.
 */
export function resolveComposerRunAction(input: ComposerRunActionInput): ComposerRunAction {
  const sessionId = input.activeSessionId;
  const agentRunActive = Boolean(sessionId && input.runningSessionIds.has(sessionId));
  const stopVisible = Boolean(sessionId && (agentRunActive || input.reviewerCheckpointRunning));
  const noModelReason = sessionId && !input.sessionArchived && !input.hasModel
    ? input.modelsAvailable ? "no-session-model" : "no-system-models"
    : null;
  return {
    noModelReason,
    runDisabled: !sessionId || !input.message.trim() || input.sessionArchived || !input.hasModel,
    runLabel: agentRunActive ? "Add to queue" : "Run analysis",
    stopDisabled: Boolean(sessionId && input.stoppingSessionIds.has(sessionId)),
    stopVisible,
  };
}

export function ComposerNoModelNotice({
  onOpenModelSettings,
  reason,
}: {
  onOpenModelSettings: () => void;
  reason: ComposerNoModelReason;
}) {
  const { t } = useLocale();
  return (
    <div className="composer-model-notice" id={COMPOSER_NO_MODEL_NOTICE_ID} role="status">
      {reason === "no-system-models" ? (
        <>
          <span>{t("composer.noModels")}</span>
          <button onClick={onOpenModelSettings} type="button">{t("composer.openModels")}</button>
        </>
      ) : (
        <span>{t("composer.noTaskModel")}</span>
      )}
    </div>
  );
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
        aria-describedby={action.noModelReason ? COMPOSER_NO_MODEL_NOTICE_ID : undefined}
        className="send-button"
        disabled={action.runDisabled}
        title={action.noModelReason ? (action.noModelReason === "no-system-models" ? t("composer.runNoModels") : t("composer.runNoTaskModel")) : undefined}
        type="submit"
      >
        <SendIcon size={15} /> {action.runLabel === "Add to queue" ? t("composer.queue") : t("composer.run")}
      </button>
    </div>
  );
}
