import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { ideaResearchPhaseLabel } from "../src/IdeaResearchLabels.js";
import { en, zhCN, type MessageKey } from "../src/i18n/messages.js";

const research = {
  template: {
    id: "scientific-hypothesis-general/v1",
    label: "通用科研假设探索",
    assessors: [{ id: "scientificValidity", label: "科学合理性" }],
  },
} as never;

// The catalogue lookup a caller already holds from `useLocale()`.
const translateWith = (catalogue: Partial<Record<MessageKey, string>>) => (key: MessageKey): string => catalogue[key] ?? en[key];

test("uses the frozen template label for an assessor phase", () => {
  const t = translateWith(zhCN);
  assert.equal(ideaResearchPhaseLabel(t, research, "scientificValidity"), "科学合理性");
  assert.equal(ideaResearchPhaseLabel(t, research, "aggregate"), "聚合评估");
});

test("engine roles follow the reader's language while template labels stay frozen", () => {
  assert.equal(ideaResearchPhaseLabel(translateWith(en), research, "aggregate"), "Aggregating assessments");
  assert.equal(ideaResearchPhaseLabel(translateWith(en), research, "scientificValidity"), "科学合理性");
  // An unknown role renders as itself rather than as nothing.
  assert.equal(ideaResearchPhaseLabel(translateWith(en), research, "brand-new-role"), "brand-new-role");
});
