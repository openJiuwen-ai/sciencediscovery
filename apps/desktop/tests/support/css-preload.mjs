// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Preload for this package's own `tsx --test` command.
 *
 * `apps/desktop/tests/research-package-trim.test.tsx` loads
 * `src/views/ResearchPackage.tsx`, which imports `../styles/research-package.css`
 * statically. `tsx` has no `.css` handling, and the shared tagged collector only
 * registers its loader inside its own entry module — which has already resolved
 * this file's static graph by the time it runs. Registering here, before the
 * test files are imported, is what makes the package command work on its own.
 */
import { register } from "node:module";

register("../../../../test/support/tagged/css-loader.mjs", import.meta.url);
