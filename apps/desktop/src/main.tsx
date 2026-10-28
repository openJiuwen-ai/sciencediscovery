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

import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { loadLocalAccessToken } from "./local-access-token.js";
import { applyDocumentLanguage } from "./text.js";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// Before the first render, so the token from `#token=` is in storage and out of
// the address bar before any request could be made with it.
const token = loadLocalAccessToken(localStorage, window.location, window.history);

// `<html lang>` before the first paint, so assistive technology and the
// browser's own text handling see the language the interface opens in.
applyDocumentLanguage();

// Deliberately not wrapped in StrictMode. Its double invocation would run the
// run-stream subscription twice, and the second subscriber would replay the
// same frames into the same reducer — a duplicated turn, not a harmless
// re-render. The one place that would have caught a real bug is the bootstrap
// effect, which is idempotent by construction.
createRoot(root).render(<App initialToken={token} />);
