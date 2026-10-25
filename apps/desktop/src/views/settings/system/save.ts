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

import { createContext, useContext, useEffect, useRef } from "react";

/** A pane's write, as the dialog's footer invokes it. `false` means the pane
 *  refused or the server rejected it — and, for 保存并关闭, that the dialog must
 *  stay open so the user can read why. */
export type SettingsSaveHandler = () => Promise<boolean>;

export interface SettingsSaveContextValue {
  register: (handler?: SettingsSaveHandler) => void;
}

export const SettingsSaveContext = createContext<SettingsSaveContextValue>({
  register: () => undefined,
});

/**
 * Publish the active pane's save handler to the dialog footer.
 *
 * The handler is held in a ref and the effect depends only on `register`, so a
 * pane re-rendering on every keystroke does not tear the registration down and
 * back up. The dialog renders one pane at a time, so there is never more than
 * one handler to choose between.
 */
export function useSettingsSave(handler: SettingsSaveHandler | undefined): void {
  const { register } = useContext(SettingsSaveContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    register(latest.current === undefined ? undefined : () => latest.current!());
    return () => register(undefined);
  }, [register, handler !== undefined]);
}
