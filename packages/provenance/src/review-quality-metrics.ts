// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ArtifactReviewRun } from "@sciencediscovery/schema";

/** Privacy-safe, derived health signals for completed Reviewer runs. */
export interface ReviewerQualityMetrics {
  deepP95Ms?: number;
  deepReviewCount: number;
  inconclusiveAssessmentCount: number;
  locatorCoverage: number;
  strongAssessmentCount: number;
  strongAssessmentWithoutLocatorCount: number;
  unverifiableContradictionCount: number;
}

export function reviewerQualityMetrics(reviews: ArtifactReviewRun[]): ReviewerQualityMetrics {
  let assessments = 0;
  let inconclusive = 0;
  let located = 0;
  let strong = 0;
  let strongWithoutLocator = 0;
  let unverifiableContradiction = 0;
  const durations: number[] = [];
  for (const review of reviews) {
    if (review.reviewLevel === "deep") {
      const duration = Date.parse(review.finishedAt) - Date.parse(review.createdAt);
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
    }
    for (const item of review.sourceAssessments ?? []) {
      assessments += 1;
      const locatorIds = new Set(item.locators.map((locator) => locator.id));
      const valid = item.assessment.locatorIds.filter((id) => locatorIds.has(id));
      if (valid.length) located += 1;
      if (item.assessment.assessment === "INCONCLUSIVE") { inconclusive += 1; continue; }
      strong += 1;
      if (!valid.length) {
        strongWithoutLocator += 1;
        if (item.assessment.assessment === "CONTRADICTED") unverifiableContradiction += 1;
      }
    }
  }
  durations.sort((left, right) => left - right);
  return {
    ...(durations.length ? { deepP95Ms: durations[Math.ceil(durations.length * 0.95) - 1] } : {}),
    deepReviewCount: durations.length,
    inconclusiveAssessmentCount: inconclusive,
    locatorCoverage: assessments ? located / assessments : 1,
    strongAssessmentCount: strong,
    strongAssessmentWithoutLocatorCount: strongWithoutLocator,
    unverifiableContradictionCount: unverifiableContradiction,
  };
}
