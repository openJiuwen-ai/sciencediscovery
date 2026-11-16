// Backward-compatibility shim: the shell platform layer moved to ./platform/
// (win32.ts / darwin.ts / index.ts — the same contract as
// packages/cas/src/platform/; platform files are never imported directly).
// This module keeps every existing import path working unchanged; new code
// should import from "./platform/index.ts" directly.

export * from "./platform/index.ts";
