// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type {ReactNode} from "react";
import {createViewRegistry} from "@sciencediscovery/plugin-sdk/views";
import {planView,type PlanViewInput} from "@sciencediscovery/plan/web";

const records=createViewRegistry<PlanViewInput,ReactNode>([planView]);
/** Recorded/active-run projections remain readable after nextRun configuration changes.
 * These views have no command port; future actions are governed by the runtime composition. */
export function ProjectRecordSlot(input:PlanViewInput) {
  const view=records.resolve(input);
  return view ? view.render(input) : null;
}
