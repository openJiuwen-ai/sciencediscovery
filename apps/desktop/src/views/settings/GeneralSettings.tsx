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

import { useLanguage } from "../../app/use-language.js";
import { setLanguage, TEXT } from "../../text.js";
import { ListSelect } from "./ListSelect.js";
import { Group, Row } from "./rows.js";

/**
 * 设置 › 通用.
 *
 * The page holds exactly one preference, and it is this browser's: the
 * language never reaches the service, so there is nothing to read back and
 * nothing to save. Picking a language applies it immediately — the same
 * behaviour as `apps/web`, and the only one that lets the user judge the
 * choice without pressing anything else.
 *
 * The picker is the app's own list rather than a native `<select>`: this is
 * the setting that decides what every other label on the page says, and an
 * OS-drawn popup in the system's own type and colours reads as a piece of the
 * operating system that wandered in.
 *
 * [mac-direct] The installation-level sandbox opt-in used to live here; it
 * moved to the 沙箱网络 group (设置 › 连接) in the same PR — see
 * SandboxDirectSettings. 通用 keeps only the browser-level preferences.
 */
export function GeneralSettings({ onShowGuide }: { onShowGuide: () => void }) {
  const language = useLanguage();
  const text = TEXT.settings.general.language;

  return (
    <>
      <Group heading={text.heading}>
        <Row title={text.field}>
          <ListSelect
            caption={false}
            choices={[
              { label: text.chinese, value: "zh-CN" },
              { label: text.english, value: "en" },
            ]}
            label={text.field}
            onChange={(next) => setLanguage(next === "en" ? "en" : "zh-CN")}
            value={language}
          />
        </Row>
      </Group>
      {/* The guide is shown once and then only on request. The request lives
          beside the language because both are preferences of this browser,
          and because this is the page a user opens when they cannot find
          something on the interface. */}
      <Group heading={TEXT.settings.general.guide.heading}>
        <Row title={TEXT.settings.general.guide.field}>
          <button className="secondary-button" onClick={onShowGuide} type="button">
            {TEXT.settings.general.guide.action}
          </button>
        </Row>
      </Group>
    </>
  );
}
