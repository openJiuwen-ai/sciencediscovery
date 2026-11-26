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
import { defineConfig, loadEnv, type Plugin } from "vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Release version + build hash, stamped into feedback metadata the same way
 *  apps/web does it so a report from either front end names its build. */
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
let build = "source";
try { build = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Release archives may omit .git. */ }

/** Control plane the dev server proxies to. `settings.port` is 4310; the
 *  JiuwenSwarm launcher keeps the adapter in front of it on that same port, so
 *  this is the only origin the UI ever talks to. Overridable so a machine
 *  already using 4310 for something else can point elsewhere without editing
 *  the file. */
const controlPlane = process.env.SCIENCE_AGENT_API_URL ?? "http://127.0.0.1:4310";

/** Account service a desktop build talks to when nothing else names one.
 *
 *  The deployment docs, `.env.example` and `docker-compose.yml` all record this
 *  address, but the desktop app was the one front end whose own build applied
 *  none of them: a bare `pnpm build` baked an empty base URL, so the sign-in
 *  navigation went to `/v1/auth/huawei/start` on this app's own static host and
 *  was answered with `index.html` (#1430). Keeping the default here leaves the
 *  resolution path (`accountsBaseUrl()`) untouched for both front ends. */
const DEFAULT_ACCOUNTS_API = "https://sciencediscovery.openjiuwen.com/accounts";

/**
 * Bakes `VITE_ACCOUNTS_API`, falling back to the desktop default.
 *
 * `loadEnv` is the same reader Vite uses, so `.env`, `.env.local` and the
 * process environment keep their precedence and an exported or file-level
 * empty value stays empty: the default is applied with `??`, never `||`,
 * because empty is the documented "same origin" opt-out. The directory is
 * taken from the config being resolved, which is also how a test can point a
 * build at a temp directory.
 */
function accountsApiDefault(): Plugin {
  return {
    name: "sciencediscovery:accounts-api-default",
    config(config, env) {
      const root = resolve(config.root ?? process.cwd());
      const envDir = config.envDir ? resolve(root, config.envDir) : root;
      const configured = loadEnv(env.mode, envDir, "VITE_").VITE_ACCOUNTS_API;
      return {
        define: {
          "import.meta.env.VITE_ACCOUNTS_API": JSON.stringify(configured ?? DEFAULT_ACCOUNTS_API),
        },
      };
    },
  };
}

export default defineConfig({
  define: { __SCIENCE_DISCOVERY_BUILD__: JSON.stringify(`${process.env.SCIENCE_DISCOVERY_VERSION ?? version} (${build})`) },
  // Deliberately no `base`: this app is meant to live at "/" so that swapping
  // it in for apps/web is a change of the static directory alone.
  plugins: [react(), accountsApiDefault()],
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
