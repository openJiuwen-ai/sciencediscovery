// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

/**
 * Z5 LaTeX-first pathway tests: the e-print downloader (binary tarball over
 * a stubbed transport) and the ingest pipeline choosing arXiv-LaTeX over
 * PDF when the ref carries an arXiv id and the e-print serves TeX.
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { BIOMEDICAL_SCHEMA } from "@sciencediscovery/knowledge-engine";

import { downloadArxivEprint } from "./connectors/eprint.js";
import { buildSourceChain } from "./connectors/source-chain.js";
import type { ScholarlyResponse, ScholarlyTransport } from "./connectors/transport.js";
import { KeJobRunner } from "./job-runner.js";
import { KeOrchestrator, KE_SEED_JOB } from "./orchestrator.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

/** Stub transport with binary bodies (bytes-first, text decoded on demand). */
function binaryTransport(routes: Array<{ match: string; status: number; body: Buffer }>): ScholarlyTransport {
  return {
    async get(url: string): Promise<ScholarlyResponse> {
      const route = routes.find((candidate) => url.includes(candidate.match));
      if (!route) throw new Error(`unexpected url: ${url}`);
      const text = route.body.toString("utf8");
      return {
        status: route.status,
        url,
        header: () => null,
        text: async () => text,
        json: async () => JSON.parse(text),
        bytes: async () => new Uint8Array(route.body),
      };
    },
  };
}

function tarEntry(name: string, data: string): Buffer {
  const content = Buffer.from(data, "utf8");
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "latin1");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.fill(" ", 148, 156);
  const sum = header.reduce((acc, byte) => acc + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\title{Latex Pathway Paper}",
  "\\begin{document}",
  "\\section{Results}",
  "The antibody mAb114 binds the glycoprotein with the affinity $K_d$ as reported by Corti \\cite{corti2016}.",
  "Extended observations follow with sufficient body text to clear the minimum extractable length gate,",
  "because the ingest path rejects compiled markdown shorter than two hundred characters.",
  "\\end{document}",
].join("\n");
const EPRINT_TARBALL = gzipSync(Buffer.concat([
  tarEntry("main.tex", MAIN_TEX),
  Buffer.alloc(1024),
]));

test("eprint: downloadArxivEprint unpacks and combines the tarball", async () => {
  const transport = binaryTransport([{ match: "/e-print/2401.00001", status: 200, body: EPRINT_TARBALL }]);
  const tex = await downloadArxivEprint("2401.00001", transport);
  assert.match(tex!, /\\documentclass/);
  assert.match(tex!, /\\cite\{corti2016\}/);
});

test("eprint: 404 mirrors and non-TeX payloads answer null", async () => {
  const missing = binaryTransport([{ match: "/e-print/", status: 404, body: Buffer.from("") }]);
  assert.equal(await downloadArxivEprint("2401.99999", missing), null);

  const notTex = binaryTransport([
    { match: "arxiv.org", status: 200, body: gzipSync(Buffer.from("just some text", "utf8")) },
    { match: "cn.arxiv.org", status: 200, body: gzipSync(Buffer.from("just some text", "utf8")) },
  ]);
  assert.equal(await downloadArxivEprint("2401.00002", notTex), null);
});

test("pipeline: arXiv ref with e-print ingests via arxiv-latex (no PDF worker)", async (context) => {
  const root = tempRoot("ke-eprint-pipeline");
  context.after(() => rm(root, { force: true, recursive: true }));

  const ARXIV_ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Latex Pathway Paper</title>
    <author><name>Anna Author</name></author>
    <published>2024-01-01T00:00:00Z</published>
    <summary>An abstract about latex pathways.</summary>
  </entry>
</feed>`;
  const transport = binaryTransport([
    { match: "/api/query", status: 200, body: Buffer.from(ARXIV_ATOM, "utf8") },
    { match: "fullTextXML", status: 404, body: Buffer.from("") }, // EuropePMC miss
    { match: "/e-print/", status: 200, body: EPRINT_TARBALL },
  ]);
  const chain = buildSourceChain({ transport });
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const orchestrator = new KeOrchestrator({
    store,
    chain,
    transport,
    schema: BIOMEDICAL_SCHEMA,
    resolveEndpoint: () => ({ baseUrl: "http://stub", model: "m" }),
    llmInvoke: async () => JSON.stringify({
      entities: [{ name: "Latex Pathway", type: "method" }],
      relations: [],
    }),
    assertUrl: async () => {},
  });
  const runner = new KeJobRunner(store);
  orchestrator.registerJobs(runner);

  const kb = store.createKnowledgeBase({ name: "Latex" });
  await orchestrator.seedKb(kb.id, "latex pathway antibody", 5);
  for (let index = 0; index < 20; index += 1) {
    if (!(await runner.tick())) break;
  }
  assert.equal(store.listJobs({ type: KE_SEED_JOB }).length, 1);

  const docs = store.listDocuments(kb.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.status, "ready");
  assert.equal(docs[0]?.sourceMeta["ingest_channel"], "arxiv-latex");
  // The compiled markdown carries the section heading, the [@rid] anchor the
  // W10 citation chain extracts from, and the inline formula — all inputs
  // the PDF path loses.
  assert.match(docs[0]?.fulltext ?? "", /## Results/);
  assert.match(docs[0]?.fulltext ?? "", /\[@corti2016\]/);
  assert.match(docs[0]?.fulltext ?? "", /\$K_d\$/);
  // Citation rows derived from the LaTeX-source anchors.
  const citations = store.listCitations(kb.id);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.dstKey, "corti2016");
});
