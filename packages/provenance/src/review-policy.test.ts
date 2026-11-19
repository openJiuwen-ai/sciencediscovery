import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  artifactEvidenceAliases,
  buildEvidenceBundle,
  citationReviewClaim,
  literatureCitationCandidates,
  normalizeEvidenceAlias,
  parseReviewAgentObject,
  promptEvidenceBundle,
  quantitativeArtifactClaims,
  semanticReviewFingerprint,
} from "./review-policy.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

const version = {
  id: "v1",
  references: [
    { kind: "evidence", id: "ev-1", label: "evidence1" },
    { kind: "artifact", id: "artifact-1", label: "Artifact 1", version: 2 },
  ],
} as never;

test("citation planning assigns stronger evidence levels to quantitative claims", () => {
  const candidates = literatureCitationCandidates("The method follows Doe et al. (2024). Results were 12% better [Doe2024].");
  assert.ok(candidates.length >= 1);
  const method = citationReviewClaim("The method follows Doe et al. (2024).", version, candidates[0]!);
  assert.equal(method.artifactVersionId, "v1");
  assert.match(method.id, /^citation:[a-f0-9]{24}$/);
  assert.equal(normalizeEvidenceAlias(" [Evidence 1] "), "evidence 1");
});

test("artifact evidence aliases and quantitative claims deduplicate repeated chips", () => {
  const content = "Result 12% [artifact1]. Repeated result 12% [Artifact 1].";
  assert.deepEqual(artifactEvidenceAliases("[Evidence 1] and [evidence1]"), ["evidence1"]);
  const claims = quantitativeArtifactClaims(content, version);
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0]!.values, ["12%"]);
  assert.equal(claims[0]!.artifactVersion, 2);
});

test("evidence bundle preserves trace identity, sanitizes prompt material and fingerprints inputs", async () => {
  const calls: string[] = [];
  const bundle = await buildEvidenceBundle("[evidence1]", version, async ({ alias, evidenceId }) => {
    calls.push(`${alias}:${evidenceId}`);
    return {
      evidence: { content: "  source fact  ", evidenceType: "paper", locator: "table 1", strength: "high" },
      paper: { title: "Paper", abstract: "A".repeat(5_000), identifier: "doi:1", identifierType: "doi", link: "https://example.test", source: "fixture", year: "2026", authors: ["Doe"] },
    } as never;
  });
  assert.deepEqual(calls, ["evidence1:ev-1"]);
  const prompted = promptEvidenceBundle(bundle);
  assert.equal((prompted[0] as any).paper.abstract.length, 4_000);
  const first = semanticReviewFingerprint("content", version, bundle, { citationSkillHash: "c", computationSkillHash: "k", modelIdentity: "m" });
  const second = semanticReviewFingerprint("content", version, [...bundle].reverse(), { citationSkillHash: "c", computationSkillHash: "k", modelIdentity: "m" });
  assert.equal(first, second);
});

test("review agent parsing accepts fenced JSON and rejects arrays or missing objects", () => {
  assert.deepEqual(parseReviewAgentObject("```json\n{\"verdict\":\"pass\"}\n```"), { verdict: "pass" });
  assert.throws(() => parseReviewAgentObject("[]"), /no JSON object/);
  assert.throws(() => parseReviewAgentObject("plain text"), /no JSON object/);
});
