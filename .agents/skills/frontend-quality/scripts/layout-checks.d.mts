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

// SPDX-License-Identifier: Apache-2.0
export interface LayoutContract {
  pageOverflow?: boolean;
  visible?: string[];
  fullText?: string[];
  actions?: string[];
  disjoint?: Array<{ a: string; b: string }>;
}
export type RuleId = 'FQ-01' | 'FQ-02' | 'FQ-03' | 'FQ-04' | 'FQ-05';
export interface LayoutIssue {
  rule: RuleId;
  kind: string;
  selector: string;
  detail: string;
  severity: 'blocked' | 'failure';
}
export interface Rect {
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
}
export interface BrowserReport {
  viewport: { width: number; height: number; clientWidth: number; clientHeight: number; dpr: number };
  toleranceCssPx: number;
  issues: LayoutIssue[];
  measurements: Array<{ rule: RuleId; selector?: string; rect?: Rect; scrollWidth?: number; clientWidth?: number }>;
  actionTargets: string[];
}
export interface LayoutReport extends Omit<BrowserReport, 'actionTargets'> {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  selectedChecks: number;
}
/** Structural subset; no new runtime or type dependency on Playwright. */
export interface LayoutPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  locator(selector: string): {
    click(options: { trial: boolean; timeout: number }): Promise<void>;
  };
}
export function validateContract(contract: unknown): asserts contract is LayoutContract;
/** Run only in a browser context, normally through checkLayout. */
export function inspectLayout(contract: LayoutContract): BrowserReport;
export function checkLayout(page: LayoutPage, contract: LayoutContract): Promise<LayoutReport>;
