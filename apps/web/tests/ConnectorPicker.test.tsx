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

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorManifest } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectorPicker, connectorName } from "../src/composer/ConnectorPicker.js";

const connectors = [
  { id: "pubmed", publisher: "NCBI", termsUrl: "https://www.ncbi.nlm.nih.gov/home/about/policies/" } as ConnectorManifest,
  { id: "uniprot", publisher: "UniProt Consortium", termsUrl: "https://www.uniprot.org/help/license" } as ConnectorManifest,
];

test("maps connector ids to display names", () => {
  assert.equal(connectorName("pubmed"), "PubMed");
  assert.equal(connectorName("europe-pmc"), "Europe PMC");
});

test("shows the enabled count on the trigger with a hover summary", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    enabledIds: ["pubmed"],
    onToggle: () => undefined,
  }));
  assert.match(markup, /aria-label="Data connectors: 1 of 2 enabled"/);
  assert.match(markup, /title="Data connectors: 1 of 2 enabled"/);
  assert.match(markup, /connector-picker-trigger has-enabled/);
  assert.match(markup, /<span class="connector-picker-count">1<\/span>/);
  assert.doesNotMatch(markup, /connector-picker-popover/);
});

test("lists every connector with its checked state and policy link when open", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    defaultOpen: true,
    enabledIds: ["pubmed"],
    onToggle: () => undefined,
  }));
  assert.match(markup, /connector-picker-popover/);
  assert.match(markup, /<strong>PubMed<\/strong>/);
  assert.match(markup, /<strong>UniProt<\/strong>/);
  const checked = markup.match(/checked/g) ?? [];
  assert.equal(checked.length, 1);
  assert.match(markup, /href="https:\/\/www\.uniprot\.org\/help\/license"/);
  assert.match(markup, /aria-label="UniProt provider policy"/);
});

test("disables the checkboxes but keeps the list readable while a run is active", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    defaultOpen: true,
    disabled: true,
    enabledIds: [],
    onToggle: () => undefined,
  }));
  assert.match(markup, /connector-picker-popover/);
  const disabled = markup.match(/disabled/g) ?? [];
  assert.equal(disabled.length, 2);
});
