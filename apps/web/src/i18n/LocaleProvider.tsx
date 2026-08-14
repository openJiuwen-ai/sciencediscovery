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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { applyLocale, detectLocale, translate, type Locale } from "./locale.js";
import type { MessageKey } from "./messages.js";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, variables?: Record<string, string | number>) => string;
}

const defaultContext: LocaleContextValue = {
  locale: "en",
  setLocale: () => undefined,
  t: (key, variables) => translate("en", key, variables),
};

const LocaleContext = createContext<LocaleContextValue>(defaultContext);

export function LocaleProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? detectLocale());

  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  const t = useCallback((key: MessageKey, variables?: Record<string, string | number>) => (
    translate(locale, key, variables)
  ), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
