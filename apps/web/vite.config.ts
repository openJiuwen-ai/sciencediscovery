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

export default defineConfig({
  plugins: [react()],
  // Pre-bundle the Mol* plugin entry points we use so their CommonJS deps
  // (e.g. mutative) get proper ESM interop. We deliberately avoid the
  // molstar/lib/apps/viewer app entry, which imports sibling .html files the
  // dependency scanner cannot parse.
  optimizeDeps: {
    include: [
      "molstar/lib/mol-plugin-ui",
      "molstar/lib/mol-plugin-ui/react18",
      "molstar/lib/mol-plugin-ui/spec",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/health": "http://127.0.0.1:4310",
    },
  },
});
