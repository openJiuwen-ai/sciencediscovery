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

import { useCallback, useEffect, useState } from "react";

export type Language = "en" | "zh";

const STORAGE_KEY = "hub-language";

const COPY = {
  all: { en: "All", zh: "全部" },
  back: { en: "Back to list", zh: "返回列表" },
  categories: { en: "Categories", zh: "分类" },
  connectors: { en: "Connectors", zh: "连接器" },
  description: { en: "Description", zh: "描述" },
  download: { en: "Download", zh: "下载" },
  downloadJson: { en: "Download JSON", zh: "下载 JSON" },
  downloadMarkdown: { en: "Download Markdown", zh: "下载 Markdown" },
  empty: { en: "No assets match these filters.", zh: "没有符合筛选条件的条目。" },
  error: { en: "Could not load the catalog", zh: "无法载入目录" },
  filters: { en: "Filters", zh: "筛选" },
  governance: { en: "Governance", zh: "治理信息" },
  hardware: { en: "Hardware", zh: "硬件" },
  instructions: { en: "Prompt", zh: "Prompt" },
  loading: { en: "Loading…", zh: "加载中…" },
  members: { en: "Team members", zh: "团队成员" },
  notFound: { en: "This asset does not exist in the catalog.", zh: "目录中没有这个条目。" },
  resources: { en: "Files", zh: "文件" },
  search: { en: "Search name or description", zh: "搜索名称或描述" },
  sessions: { en: "Session packages", zh: "会话包" },
  skills: { en: "Skills", zh: "技能" },
  source: { en: "Source", zh: "来源" },
  specialists: { en: "Specialists", zh: "专家" },
  toolCount: { en: "tools", zh: "个工具" },
  tools: { en: "Tools", zh: "工具" },
  type: { en: "Type", zh: "类型" },
  version: { en: "Version", zh: "版本" },
  config: { en: "Launch configuration", zh: "连接配置" },
  boundSkills: { en: "Skills", zh: "绑定技能" },
  boundConnectors: { en: "Connectors", zh: "绑定连接器" },
  count: { en: "assets", zh: "个条目" },
} as const;

export type CopyKey = keyof typeof COPY;

export function initialLanguage(): Language {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function useLanguage(): { language: Language; toggle: () => void } {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);
  const toggle = useCallback(() => setLanguage((current) => (current === "zh" ? "en" : "zh")), []);
  return { language, toggle };
}

export function useCopy(language: Language): (key: CopyKey) => string {
  return useCallback((key: CopyKey) => COPY[key][language], [language]);
}
