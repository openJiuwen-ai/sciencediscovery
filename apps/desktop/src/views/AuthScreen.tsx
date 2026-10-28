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

import { useState } from "react";

import { TEXT } from "../text.js";

interface Props {
  /** Distinguishes "no token yet" from "the server refused this one", which
   *  are fixed by different actions: paste it, versus re-copy it. */
  rejected: boolean;
  onSubmit: (token: string) => void;
}

/**
 * The one screen between a running backend and a usable app.
 *
 * The API has no unauthenticated route except `/health`, so there is nothing to
 * show without a token — this is a gate, not a prompt. The token lives in the
 * launch output (or in the app's own address bar as `#token=`), and saying so
 * is the only actionable thing this screen can do.
 */
export function AuthScreen({ onSubmit, rejected }: Props) {
  const [value, setValue] = useState("");
  const submit = () => {
    const token = value.trim();
    if (token !== "") onSubmit(token);
  };
  return (
    <div className="boot-page">
      <div className="boot-card">
        <div className="boot-mark" aria-hidden="true">
          ⬡
        </div>
        <h1 className="boot-title">
          {rejected ? TEXT.boot.rejectedTitle : TEXT.boot.noTokenTitle}
        </h1>
        <p className="boot-body">{rejected ? TEXT.boot.rejectedBody : TEXT.boot.noTokenBody}</p>
        <form
          className="boot-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span className="field-label">{TEXT.boot.tokenLabel}</span>
            <input
              autoComplete="off"
              autoFocus
              className="field-input"
              onChange={(event) => setValue(event.target.value)}
              placeholder={TEXT.boot.tokenPlaceholder}
              spellCheck={false}
              value={value}
            />
          </label>
          <button className="primary-button" disabled={value.trim() === ""} type="submit">
            {TEXT.boot.tokenSubmit}
          </button>
        </form>
      </div>
    </div>
  );
}
