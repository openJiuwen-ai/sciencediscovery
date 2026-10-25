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

import type { ApiClient } from "../api/client.js";
import type { ModelProvider, ModelProviderPreset } from "../api/types.js";
import { TEXT } from "../text.js";
import { ModelForm, type ModelFormResult } from "./ModelForm.js";

interface Props {
  client: ApiClient;
  onConfigured: (result: ModelFormResult) => void | Promise<void>;
  /** Re-reads the catalog so a second attempt in this session sees the provider
   *  the first one created, and updates it instead of duplicating it. */
  onProvidersChanged: () => void | Promise<void>;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
}

/**
 * The model step, for a launch that found no model.
 *
 * Workspace selection and backend startup already happened before this bundle
 * is loaded: the Electron shell chooses the data directory and waits for the
 * local service. What is left is the one thing the SPA itself owns — a
 * provider, a model, and the default selection — so this page is a single step
 * in the same split-screen language as the shell wizard, not a second copy of
 * the workspace and boot screens.
 *
 * The form is the shared `ModelForm`; `revealSubmitOnSuccess` makes its test
 * the primary action and keeps the final button hidden until that test passes,
 * which is the same 测试并继续 → 开始使用 order the shell uses.
 */
export function SetupWizard({
  client,
  onConfigured,
  onProvidersChanged,
  presets,
  providers,
}: Props) {
  return (
    <div className="wizard-page">
      <main className="wizard-pane">
        <header className="wizard-brand">
          <span className="wizard-brand-mark" aria-hidden="true">
            <svg
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.7"
              viewBox="0 0 24 24"
            >
              <path d="M9 3h6" />
              <path d="M10 3v5.2L5.2 17a2.4 2.4 0 0 0 2.1 3.6h9.4a2.4 2.4 0 0 0 2.1-3.6L14 8.2V3" />
              <path d="M7.5 15h9" />
            </svg>
          </span>
          <span className="wizard-brand-name">{TEXT.appName}</span>
        </header>

        <div className="wizard-scroll">
          <div className="wizard-content">
            <div className="wizard-progress" aria-hidden="true">
              <span />
            </div>

            <section>
              <h1>{TEXT.wizard.title}</h1>
              <p className="wizard-sub">{TEXT.wizard.sub}</p>

              <div className="wizard-form">
                <ModelForm
                  client={client}
                  onConfigured={onConfigured}
                  onProvidersChanged={onProvidersChanged}
                  presets={presets}
                  providers={providers}
                  revealSubmitOnSuccess
                  submitLabel={TEXT.wizard.finish}
                  testLabel={TEXT.wizard.testAndContinue}
                />
              </div>
            </section>
          </div>
        </div>
      </main>

      <aside className="wizard-art" aria-hidden="true">
        <div className="wizard-art-copy">
          <h2>{TEXT.wizard.art.title}</h2>
          <p>{TEXT.wizard.art.sub}</p>
        </div>
      </aside>
    </div>
  );
}
