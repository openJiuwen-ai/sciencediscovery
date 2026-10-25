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
import { Group, Row, Select } from "./rows.js";

/**
 * 设置 › 通用.
 *
 * The page holds exactly one preference, and it is this browser's: the
 * language never reaches the service, so there is nothing to read back and
 * nothing to save. Picking a language applies it immediately — the same
 * behaviour as `apps/web`, and the only one that lets the user judge the
 * choice without pressing anything else.
 */
export function GeneralSettings() {
  const language = useLanguage();
  const text = TEXT.settings.general.language;

  return (
    <Group heading={text.heading}>
      <Row title={text.field}>
        <Select
          label={text.field}
          onChange={(next) => setLanguage(next === "en" ? "en" : "zh-CN")}
          options={[
            { label: text.chinese, value: "zh-CN" },
            { label: text.english, value: "en" },
          ]}
          value={language}
        />
      </Row>
    </Group>
  );
}
