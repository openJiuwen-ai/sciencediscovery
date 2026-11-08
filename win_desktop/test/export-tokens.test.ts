import test from "node:test";
import assert from "node:assert/strict";
import { ExportDestinations } from "../src/export-tokens.ts";

test("an issued token resolves to the path the dialog chose", () => {
  const destinations = new ExportDestinations();
  destinations.issue("token-1", "C:\\Users\\me\\Downloads\\study.sdresearch");
  assert.equal(destinations.resolve("token-1")?.path, "C:\\Users\\me\\Downloads\\study.sdresearch");
});

test("a token the process never issued resolves to nothing", () => {
  const destinations = new ExportDestinations();
  destinations.issue("token-1", "C:\\picked.sdresearch");
  // This is the renderer naming its own file: no path, so the write is refused.
  assert.equal(destinations.resolve("C:\\Windows\\System32\\drivers\\etc\\hosts"), undefined);
  assert.equal(destinations.resolve(""), undefined);
});

test("written destinations are marked without losing resolvability", () => {
  const destinations = new ExportDestinations();
  destinations.issue("token-1", "C:\\picked.sdresearch");
  assert.equal(destinations.resolve("token-1")?.written, false);
  destinations.markWritten("token-1");
  const entry = destinations.resolve("token-1");
  assert.equal(entry?.written, true);
  // Revealing in the folder still works after the write.
  assert.equal(entry?.path, "C:\\picked.sdresearch");
});

test("the oldest destination is evicted past the limit", () => {
  const destinations = new ExportDestinations(2);
  destinations.issue("a", "C:\\a.sdresearch");
  destinations.issue("b", "C:\\b.sdresearch");
  destinations.issue("c", "C:\\c.sdresearch");
  assert.equal(destinations.size, 2);
  assert.equal(destinations.resolve("a"), undefined);
  assert.equal(destinations.resolve("b")?.path, "C:\\b.sdresearch");
  assert.equal(destinations.resolve("c")?.path, "C:\\c.sdresearch");
});