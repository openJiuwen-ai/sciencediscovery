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

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Control plane the dev server proxies to. `settings.port` is 4310; the
 *  JiuwenSwarm launcher keeps the adapter in front of it on that same port, so
 *  this is the only origin the UI ever talks to. Overridable so a machine
 *  already using 4310 for something else can point elsewhere without editing
 *  the file. */
const controlPlane = process.env.SCIENCE_AGENT_API_URL ?? "http://127.0.0.1:4310";

export default defineConfig({
  // Deliberately no `base`: this app is meant to live at "/" so that swapping
  // it in for apps/web is a change of the static directory alone.
  plugins: [react()],
  // Pre-bundle the Mol* entry points the structure viewer imports. They are
  // reached through a lazy import, so the dev server would otherwise discover
  // them on the first structure someone opens and reload the page under them;
  // pre-bundling also gives their CommonJS dependencies (mutative) proper ESM
  // interop. The `molstar/lib/apps/viewer` app entry is deliberately absent: it
  // imports sibling `.html` files the dependency scanner cannot parse.
  optimizeDeps: {
    include: [
      "molstar/lib/mol-plugin-state/builder/structure/hierarchy-preset.js",
      "molstar/lib/mol-plugin-ui/index.js",
      "molstar/lib/mol-plugin-ui/spec.js",
      "molstar/lib/mol-util/color/index.js",
    ],
  },
  // The built output needs the same two proxies as the dev server: the app has
  // no absolute API origin, so without them `vite preview` would show the
  // offline screen. Reviewing the real bundle against a live stack is the point
  // of this block — swapping `SCIENCE_AGENT_WEB_DIR` needs a service restart,
  // which is a much heavier thing to ask of a machine already in use.
  preview: {
    host: "127.0.0.1",
    port: 4174,
    proxy: {
      "/api": controlPlane,
      "/health": controlPlane,
    },
  },
  server: {
    host: "127.0.0.1",
    // 5173 belongs to apps/web; the two front ends run side by side in dev.
    port: 5174,
    proxy: {
      "/api": controlPlane,
      "/health": controlPlane,
    },
  },
});
