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

import { TEXT } from "../text.js";

/**
 * The names this app gives the provider it creates for a custom gateway.
 *
 * The name is sent once, when the provider is created (`ModelForm`), and then
 * stored by the service — so a gateway configured in Chinese keeps the Chinese
 * name after the interface is switched to English, and the other way round.
 * Both literals therefore have to be recognised on the way out. A name the
 * user typed (or one a preset supplied) is returned untouched: only the
 * default this app itself wrote is a translatable string.
 */
const CUSTOM_GATEWAY_NAMES = ["自定义网关", "Custom gateway"];

/** The separator the service joins a provider's name and the model's label
 *  with, e.g. `自定义网关 · DeepSeek-V4.1-Flash`. */
const LABEL_SEPARATOR = " · ";

export function providerName(name: string): string {
  for (const known of CUSTOM_GATEWAY_NAMES) {
    if (name === known) return TEXT.wizard.custom.name;
    // A profile's name is the provider and the model label joined by the
    // service, so only the provider half is this app's own string.
    if (name.startsWith(`${known}${LABEL_SEPARATOR}`)) {
      return `${TEXT.wizard.custom.name}${name.slice(known.length)}`;
    }
  }
  return name;
}

/**
 * The model half of a profile's name.
 *
 * A menu row has one line for a name and an icon for the provider, so it shows
 * the model alone: `月之暗面 · Kimi-K3` is a row with 月之暗面's mark and the
 * words `Kimi-K3`. The whole name stays on the row's tooltip. A standalone
 * profile — no provider half to drop — is returned untouched.
 */
export function modelLabel(name: string): string {
  const separator = name.lastIndexOf(LABEL_SEPARATOR);
  return separator === -1 ? name : name.slice(separator + LABEL_SEPARATOR.length);
}
