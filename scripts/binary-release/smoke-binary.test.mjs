import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNoSeaCrash } from "./smoke-binary.mjs";

test("accepts ordinary launcher output", () => {
  assert.doesNotThrow(() => assertNoSeaCrash("ScienceDiscovery is ready at http://127.0.0.1:4310", "serve"));
});

test("rejects known SEA startup crash signals", () => {
  for (const signal of ["SIGABRT", "v8::ToLocalChecked", "Aborted (core dumped)"]) {
    assert.throws(() => assertNoSeaCrash(signal, "serve"), /serve emitted SEA crash signal/);
  }
});
