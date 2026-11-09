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

import { useEffect, useRef } from "react";

import { claimsEscape, enterDialog, isTopDialog, leaveDialog } from "./dialog-escape.js";

/**
 * Escape closes this dialog, if it is the topmost one.
 *
 * Registered on `document` because focus can be anywhere inside a dialog, and
 * every dialog registers on the same node, so the token is what decides which
 * one answers: a dialog opened over this one takes the key, and this one stays
 * open. `enabled` is for a dialog standing back on purpose — an artifact whose
 * full-screen viewer is above it leaves the key to the viewer.
 */
export function useTopmostEscape(onEscape: () => void, enabled = true): void {
  const token = useRef<symbol | null>(null);

  useEffect(() => {
    const entered = enterDialog();
    token.current = entered;
    return () => {
      leaveDialog(entered);
      if (token.current === entered) token.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const current = token.current;
      if (current === null || !isTopDialog(current) || !claimsEscape(event)) return;
      event.preventDefault();
      onEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, onEscape]);
}
