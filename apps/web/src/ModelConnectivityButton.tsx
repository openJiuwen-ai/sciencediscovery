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

import { useEffect, useRef, useState } from "react";

import type { ModelConnectivityTestCategory, ModelConnectivityTestResult } from "@sciencediscovery/schema";

import { AlertCircleIcon, CheckIcon, SpinnerIcon } from "./icons.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { result: ModelConnectivityTestResult; status: "result" }
  | { message: string; status: "request_error" };

export interface ModelConnectivityButtonProps {
  disabled?: boolean;
  modelId: string;
  modelName: string;
  profileVersion: string;
  testModel: (modelId: string) => Promise<ModelConnectivityTestResult>;
}

function failureCopy(category: ModelConnectivityTestCategory, t: Translate): { label: string; title: string } {
  switch (category) {
    case "missing_token":
      return { label: t("settings.modelTest.missingToken"), title: t("settings.modelTest.missingTokenDetail") };
    case "authorization":
      return { label: t("settings.modelTest.authorization"), title: t("settings.modelTest.authorizationDetail") };
    case "not_found":
      return { label: t("settings.modelTest.notFound"), title: t("settings.modelTest.notFoundDetail") };
    case "rate_limited":
      return { label: t("settings.modelTest.rateLimited"), title: t("settings.modelTest.rateLimitedDetail") };
    case "timeout":
      return { label: t("settings.modelTest.timeout"), title: t("settings.modelTest.timeoutDetail") };
    case "network":
      return { label: t("settings.modelTest.network"), title: t("settings.modelTest.networkDetail") };
    case "provider_error":
      return { label: t("settings.modelTest.providerError"), title: t("settings.modelTest.providerErrorDetail") };
    case "invalid_response":
      return { label: t("settings.modelTest.invalidResponse"), title: t("settings.modelTest.invalidResponseDetail") };
    case "ok":
      return { label: t("settings.modelTest.test"), title: t("settings.modelTest.testAgain") };
  }
}

export function ModelConnectivityButton({
  disabled = false,
  modelId,
  modelName,
  profileVersion,
  testModel,
}: ModelConnectivityButtonProps) {
  const { t } = useLocale();
  const [state, setState] = useState<TestState>({ status: "idle" });
  const requestRevision = useRef(0);

  useEffect(() => {
    requestRevision.current += 1;
    setState({ status: "idle" });
  }, [modelId, profileVersion]);

  async function runTest(): Promise<void> {
    const revision = ++requestRevision.current;
    setState({ status: "testing" });
    try {
      const result = await testModel(modelId);
      if (requestRevision.current === revision) setState({ result, status: "result" });
    } catch (reason) {
      if (requestRevision.current !== revision) return;
      setState({
        message: reason instanceof Error ? reason.message : t("settings.modelTest.requestErrorDetail"),
        status: "request_error",
      });
    }
  }

  let className = "model-test-button";
  let icon = null;
  let label = t("settings.modelTest.test");
  let title = t("settings.modelTest.testModel", { name: modelName });
  if (disabled) {
    label = t("settings.modelTest.saveFirst");
    title = t("settings.modelTest.saveFirstDetail");
  } else if (state.status === "testing") {
    className += " testing";
    icon = <SpinnerIcon className="spin" size={14} />;
    label = t("settings.modelTest.testing");
    title = t("settings.modelTest.testingModel", { name: modelName });
  } else if (state.status === "result" && state.result.ok) {
    className += " success";
    icon = <CheckIcon size={14} />;
    label = t("settings.modelTest.success", { latency: state.result.latencyMs });
    title = t("settings.modelTest.successDetail", { latency: state.result.latencyMs });
  } else if (state.status === "result") {
    const copy = failureCopy(state.result.category, t);
    className += " failure";
    icon = <AlertCircleIcon size={14} />;
    label = copy.label;
    title = copy.title;
  } else if (state.status === "request_error") {
    className += " failure";
    icon = <AlertCircleIcon size={14} />;
    label = t("settings.modelTest.requestError");
    title = `${t("settings.modelTest.requestErrorDetail")} ${state.message}`;
  }

  return (
    <button
      aria-busy={state.status === "testing"}
      aria-label={title}
      className={className}
      disabled={disabled || state.status === "testing"}
      onClick={() => void runTest()}
      title={title}
      type="button"
    >
      {icon}
      <span aria-live="polite">{label}</span>
    </button>
  );
}
