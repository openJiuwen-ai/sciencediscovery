import assert from "node:assert/strict";
import test from "node:test";

import { ideaResearchPhaseLabel } from "../src/IdeaResearchLabels.js";

const research = {
  template: {
    id: "scientific-hypothesis-general/v1",
    label: "通用科研假设探索",
    assessors: [{ id: "scientificValidity", label: "科学合理性" }],
  },
} as never;

test("uses the frozen template label for an assessor phase", () => {
  assert.equal(ideaResearchPhaseLabel(research, "scientificValidity"), "科学合理性");
  assert.equal(ideaResearchPhaseLabel(research, "aggregate"), "聚合评估");
});
