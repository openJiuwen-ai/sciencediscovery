// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { PROVIDER_FAULT } from './provider-fault.mjs';

/** Results that represent an executed case which did not pass. */
export function retryableCaseFailures(results = []) {
  return (Array.isArray(results) ? results : []).filter(result =>
    result?.outcome === 'FAIL' || result?.outcome === PROVIDER_FAULT);
}

/** Profiles that run paid validation can retry each failed case once. */
export const shouldRetryFailedCases = profile => profile === 'daily' || profile === 'release';

/** An executed retry did not produce a report. */
export const retryReportMissing = 'PROVIDER_FAULT_RETRY_REPORT_MISSING';

/** The retry process itself failed before producing a usable final result. */
export const retryFailed = code => `PROVIDER_FAULT_RETRY_FAILED: ${code}`;
