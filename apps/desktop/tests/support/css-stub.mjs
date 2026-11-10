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

// `apps/desktop` views import their stylesheet for the side effect of loading
// it in a browser bundle. Node has no loader for `.css`, so a component test
// that mounts such a view would fail on the import before reaching any
// assertion. This hook answers every `.css` import with an empty module; the
// styles themselves are covered by the visual/E2E runs, not by a unit test.
import { register } from "node:module";

register("./css-stub-hooks.mjs", import.meta.url);
