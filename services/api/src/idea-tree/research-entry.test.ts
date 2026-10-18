// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { runIdeaResearchProtocolJourney } from "../../../../test/api/idea-research-protocol-journey.mjs";

test("public IdeaTree entry completes actual Python research through all three native protocol families", async () => {
  // UT prepares the locked evolve venv; independent ST deliberately does not.
  await runIdeaResearchProtocolJourney();
});
