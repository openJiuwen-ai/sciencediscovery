// Static assertions over build/installer.nsh and its coupled constants.
//
// Why these live here rather than in a real install run: every failure this
// guards against is a CROSS-FILE COUPLING that drifts silently. makensis proves
// the script compiles; it cannot prove that the install root the script writes
// is the one assemble-backend.mjs budgeted MAX_PATH against, or that the root is
// still disjoint from the data dir the wizard defaults to. Both of those have
// already broken once (problems W15: a threshold back-derived from a stale
// measurement; problems W16: two defaults that were the same literal, so
// uninstalling deleted user data).
//
// The literals are read out of the source files, not restated here — an
// assertion that repeats a constant cannot catch that constant changing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRootCollision } from "../src/wizard-data-dir.ts";

const winDesktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(winDesktopDir, rel), "utf8");

const installerNsh = read("build/installer.nsh");
const assembleBackend = read("scripts/assemble-backend.mjs");
const wizardDataDir = read("src/wizard-data-dir.ts");
const builderYml = read("electron-builder.yml");

/** A 20-char Windows username is the platform maximum, so this is the worst
 * case every budget in these files is measured against (problems W6). */
const USERNAME = "u".repeat(20);
const LOCALAPPDATA = `C:\\Users\\${USERNAME}\\AppData\\Local`;

/** The `%LOCALAPPDATA%\<name>` literal customInit falls back to. */
function installRootName(): string {
  const m = /StrCpy \$INSTDIR "\$LOCALAPPDATA\\([A-Za-z0-9_-]+)"/.exec(installerNsh);
  assert.ok(m, "customInit's default-root StrCpy not found in installer.nsh");
  return m![1];
}

/** The name defaultDataDir() joins onto LOCALAPPDATA. */
function defaultDataDirName(): string {
  const m = /join\(env\.LOCALAPPDATA, "([A-Za-z0-9_-]+)"\)/.exec(wizardDataDir);
  assert.ok(m, "defaultDataDir's LOCALAPPDATA join not found in wizard-data-dir.ts");
  return m![1];
}

/** `!define SD_INSTALL_ROOT_MAX <n>` from installer.nsh. */
function installRootMax(): number {
  const m = /!define SD_INSTALL_ROOT_MAX (\d+)/.exec(installerNsh);
  assert.ok(m, "SD_INSTALL_ROOT_MAX not defined in installer.nsh");
  return Number(m![1]);
}

/** The four registers of customInit's install-root decision, in source order:
 * the InstallLocation read, its emptiness test, GetDParameter's outVar, and the
 * test of THAT result. One variable threaded through four places — if any of the
 * four is renamed on its own the chain silently breaks (see the test below). */
function installRootRegisters(): { read: string; testRead: string; dparam: string; testDparam: string } {
  // Built from parts rather than as a literal: the chain spans four source
  // lines and the working tree is CRLF, and a regex literal cannot hold a
  // newline. Each `\s*` already absorbs the line break (and the \r).
  const m = new RegExp([
    'ReadRegStr (\\$R?\\d+) SHCTX "\\$\\{INSTALL_REGISTRY_KEY\\}" "InstallLocation"\\s*',
    '\\$\\{If\\} (\\$R?\\d+) == ""\\s*',
    '!insertmacro GetDParameter (\\$R?\\d+)\\s*',
    '\\$\\{If\\} (\\$R?\\d+) == ""',
  ].join("")).exec(installerNsh);
  assert.ok(m, "customInit's install-root decision chain not found in installer.nsh");
  return { read: m![1], testRead: m![2], dparam: m![3], testDparam: m![4] };
}

/** `const DEFAULT_ROOT_LEN = <n>` from assemble-backend.mjs. */
function assembleDefaultRootLen(): number {
  const m = /const DEFAULT_ROOT_LEN = (\d+)/.exec(assembleBackend);
  assert.ok(m, "DEFAULT_ROOT_LEN not found in assemble-backend.mjs");
  return Number(m![1]);
}

// ---------------------------------------------------------------------------
// problems W17: the registry key that carries InstallLocation.
// ---------------------------------------------------------------------------

test("installer.nsh reads InstallLocation from the key electron-builder WRITES", () => {
  // app-builder-lib 26.15.3 writes InstallLocation exactly once, into
  // ${INSTALL_REGISTRY_KEY} (templates/nsis/include/installer.nsh:104);
  // ${UNINSTALL_REGISTRY_KEY} carries DisplayName / UninstallString /
  // DisplayVersion and never InstallLocation. multiUser.nsh:26 reads the
  // install key too, which is the tell that the earlier version of this file
  // had it backwards.
  const reads = [...installerNsh.matchAll(
    /ReadRegStr (\$R?\d+) SHCTX "\$\{(\w+)\}" "?InstallLocation"?/g,
  )].map((m) => ({ outVar: m[1], key: m[2] }));
  assert.ok(reads.length >= 1, "expected customInit to read InstallLocation at all");
  for (const { outVar, key } of reads) {
    assert.equal(key, "INSTALL_REGISTRY_KEY",
      `InstallLocation was read from \${${key}} — that key never carries it, so the read always yields ""`);
    assert.ok(outVar !== "$R8" && outVar !== "$R9",
      `${outVar} is clobbered by GetDParameter's own register restore`);
  }
});

test("customInit's install-root chain threads ONE register through all four steps", () => {
  // This is the coupling the test above cannot see on its own. The chain is:
  //   ReadRegStr $R3 ... InstallLocation   →   ${If} $R3 == ""
  //   !insertmacro GetDParameter $R3       →   ${If} $R3 == ""
  // GetDParameter writes its outVar and only THEN pops its five saved registers
  // back over it (multiUser.nsh:105-137), so $R8/$R9 as outVar are overwritten
  // by their own cleanup — the /D= fallback would then always fire. The four
  // registers must be identical, and none of them may be $R8/$R9.
  const r = installRootRegisters();
  assert.equal(r.testRead, r.read,
    `the emptiness test reads ${r.testRead} but ReadRegStr wrote ${r.read} — `
    + `the prior-install check would always take the fallback branch`);
  assert.equal(r.dparam, r.read,
    `GetDParameter writes ${r.dparam} but the ${r.read} emptiness test above it `
    + `already branched — the two reads of the install root disagree`);
  assert.equal(r.testDparam, r.dparam,
    `the /D= emptiness test reads ${r.testDparam} but GetDParameter wrote ${r.dparam} — `
    + `the default-root StrCpy would always fire, clobbering every /D= install`);
  for (const [where, reg] of [["ReadRegStr", r.read], ["GetDParameter", r.dparam]] as const) {
    assert.ok(reg !== "$R8" && reg !== "$R9",
      `${where} uses ${reg}, which GetDParameter's own restore clobbers`);
  }
});

test("installer.nsh never writes InstallLocation itself", () => {
  // If it did, the read above would be proving its own assumption.
  assert.equal(/WriteRegStr[^]*InstallLocation/.test(installerNsh), false);
});

// ---------------------------------------------------------------------------
// problems W16: the install root must not overlap the data dir.
// ---------------------------------------------------------------------------

test("the default install root and the default data dir are different names", () => {
  const root = installRootName();
  const data = defaultDataDirName();
  assert.notEqual(root, data,
    "the two defaults must not be the same literal: the uninstall tail deletes "
    + "$INSTDIR unconditionally, so a user who accepted the wizard default "
    + "would lose envs/, secrets/ and every session (problems W16)");
});

test("the default install root does not collide with the default data dir", () => {
  // Run the shipped gate over the two REAL defaults, so renaming either side
  // into a parent/child of the other fails here.
  const root = join(LOCALAPPDATA, installRootName());
  const data = join(LOCALAPPDATA, defaultDataDirName());
  const verdict = installRootCollision(data, root);
  assert.equal(verdict.collides, false, `${data} vs ${root}: ${verdict.reason}`);
});

test("the default install root contains APP_FILENAME, so instFilesPre cannot re-expand it", () => {
  // assistedInstaller.nsh:33-38 appends "\<APP_FILENAME>" whenever $INSTDIR does
  // not already contain it. A short root name ("SD") would therefore be
  // re-expanded to SD\ScienceDiscovery, and every budget below would be
  // measuring the wrong string. APP_FILENAME is the productName for this app
  // (oneClick:false → targetUtil.js:40-41 takes the productFilename branch).
  const appFilename = /^productName:\s*(.+)$/m.exec(builderYml);
  assert.ok(appFilename, "productName not found in electron-builder.yml");
  const root = installRootName();
  assert.ok(root.includes(appFilename![1].trim()),
    `the install root "${root}" must contain APP_FILENAME "${appFilename![1].trim()}"`);
});

// ---------------------------------------------------------------------------
// The MAX_PATH budget coupling (problems W6 / W15, lessons L46).
// ---------------------------------------------------------------------------

test("assemble-backend's DEFAULT_ROOT_LEN matches the install root installer.nsh actually uses", () => {
  // maxRelRuntime is derived as MAX_PATH_USABLE - DEFAULT_ROOT_LEN - 1, so a
  // too-small DEFAULT_ROOT_LEN reports headroom the payload does not have and
  // the A5 gate passes a tree that breaches MAX_PATH — the same
  // "threshold derived from a stale measurement" failure as problems W15, just
  // in the unsafe direction.
  const root = join(LOCALAPPDATA, installRootName());
  assert.equal(assembleDefaultRootLen(), root.length,
    `DEFAULT_ROOT_LEN is ${assembleDefaultRootLen()} but the real default root `
    + `"${root}" is ${root.length} chars at a 20-char username (the Windows cap)`);
});

test("the default install root fits SD_INSTALL_ROOT_MAX with margin", () => {
  const root = join(LOCALAPPDATA, installRootName());
  const max = installRootMax();
  assert.ok(root.length <= max,
    `the default root is ${root.length} chars but SD_INSTALL_ROOT_MAX is ${max}`);
  // The margin is what makes the guard meaningful rather than nominal: at 0 the
  // default root would itself trip the warning dialog on every install.
  assert.ok(max - root.length >= 2,
    `only ${max - root.length} char(s) of headroom left under SD_INSTALL_ROOT_MAX`);
});

test("the budget chain in assemble-backend.mjs is arithmetically consistent", () => {
  // Recompute from the source constants rather than trusting the comments'
  // numbers: the comments have been wrong before (198/179 vs the real 195/176).
  const num = (name: string): number => {
    const m = new RegExp(`const ${name} = (\\d+)`).exec(assembleBackend);
    assert.ok(m, `${name} not found in assemble-backend.mjs`);
    return Number(m![1]);
  };
  const usable = num("MAX_PATH_USABLE");
  const rootLen = num("DEFAULT_ROOT_LEN");
  const margin = num("COMPILEALL_TEMP_MARGIN");
  const expectRuntime = usable - rootLen - 1;
  const expectBuild = expectRuntime - margin;
  const actualRuntime = /const maxRelRuntime = MAX_PATH_USABLE - DEFAULT_ROOT_LEN - 1;.*?(\d+)/s.exec(assembleBackend);
  const actualBuild = /const maxRelBuild = maxRelRuntime - COMPILEALL_TEMP_MARGIN;.*?(\d+)/s.exec(assembleBackend);
  assert.ok(actualRuntime, "maxRelRuntime derivation not found");
  assert.ok(actualBuild, "maxRelBuild derivation not found");
  assert.equal(Number(actualRuntime![1]), expectRuntime,
    `the maxRelRuntime comment says ${actualRuntime![1]}, arithmetic says ${expectRuntime}`);
  assert.equal(Number(actualBuild![1]), expectBuild,
    `the maxRelBuild comment says ${actualBuild![1]}, arithmetic says ${expectBuild}`);
  // MAX_PATH is 260 INCLUDING the NUL, so the usable component length is 259
  // unless LongPathsEnabled is set (problems W6 measured failures at ~265).
  assert.equal(usable, 259);
});

// ---------------------------------------------------------------------------
// The uninstall tail must resolve the same data dir the shell writes.
// ---------------------------------------------------------------------------

test("customUnInstall's data-dir fallback is defaultDataDir(), not the install root", () => {
  // installer.nsh resolves $R5 for the "also delete user data" section and
  // falls back to a literal when data-dir.txt is absent. That fallback must be
  // the DATA dir: pointing it at the install root would make the optional
  // section delete the program tree twice and leave real user data behind.
  const m = /StrCpy \$R5 "\$LOCALAPPDATA\\([A-Za-z0-9_-]+)"/.exec(installerNsh);
  assert.ok(m, "customUnInstall's data-dir fallback not found");
  assert.equal(m![1], defaultDataDirName(),
    `the uninstall fallback is "${m![1]}" but defaultDataDir() is "${defaultDataDirName()}"`);
  assert.notEqual(m![1], installRootName(),
    "the uninstall fallback must not be the install root");
});

test("the collision guard and the length guard share the final-root append rule", () => {
  // Both guards run in customPageAfterChangeDir, where $INSTDIR still lacks the
  // \${APP_FILENAME} that instFilesPre appends later. Each must replicate that
  // append DECISION before measuring, or one systematically under-counts
  // 1+16 chars. The decision is the same ${StrContains} test in both; how the
  // compensation is applied differs and legitimately so — the length guard adds
  // StrLen(APP_FILENAME)+1 to a number it is counting, the collision guard
  // needs the resulting STRING to compare, so it concatenates.
  const page = /!macro customPageAfterChangeDir([\s\S]*?)!macroend/.exec(installerNsh);
  assert.ok(page, "customPageAfterChangeDir macro not found");
  const body = page![1];
  const containsChecks = body.split("${StrContains}").length - 1;
  assert.ok(containsChecks >= 2,
    `expected BOTH guards to test whether $INSTDIR already carries APP_FILENAME, `
    + `found ${containsChecks} StrContains check(s)`);
  assert.ok(body.includes('\\${APP_FILENAME}"'),
    "the collision guard must build the final root string to compare against");
  assert.ok(/IntOp \$0 \$0 \+ 1/.test(body) && /IntOp \$0 \$0 \+ \$1/.test(body),
    "the length guard must count the appended backslash AND the product name");
  // The collision guard must read the shell's mirror file so an UPGRADE is
  // checked against the user's real data dir, not just the default.
  assert.ok(body.includes("$APPDATA\\sd-shell\\data-dir.txt"),
    "the collision guard must read data-dir.txt (the wizard's mirror) to cover upgrades");
});

test("both install-dir guards cancel with Quit, never Abort", () => {
  // Both guards live in a custom page's CREATOR function, where Abort means
  // "skip this page" — the wizard advances to InstFiles and installs into the
  // root the user just declined, while the MessageBox and DetailPrint claim it
  // returned to the directory page. That shipped as eb99ee2e and was caught by
  // review (agent-ci-infra-bot F9), not by any test; this one exists so the
  // regression cannot come back silently.
  const page = /!macro customPageAfterChangeDir([\s\S]*?)!macroend/.exec(installerNsh);
  assert.ok(page, "customPageAfterChangeDir macro not found");
  const body = page![1];

  // Comment lines are stripped first: the header explains why Abort is wrong, so
  // the word appears in prose. Only an instruction-line Abort is a regression.
  const code = body
    .split(/\r?\n/)
    .filter((l) => !/^\s*;/.test(l))
    .join("\n");
  assert.ok(!/^\s*Abort\s*$/m.test(code),
    "a guard declines with Abort, which in a custom page creator only skips the "
    + "page and lets the install continue into the rejected directory — use Quit");

  // Each of the two guards needs its own cancel: one MessageBox per guard, one
  // Quit per guard, and the Quit must be the instruction right after the
  // DetailPrint that logs the decline (IDYES jumps past it).
  const declines = code.match(/^\s*Quit\s*$/gm) ?? [];
  assert.equal(declines.length, 2,
    `expected one Quit per guard (length + collision), found ${declines.length}`);
  const msgBoxes = code.match(/MessageBox MB_YESNO/g) ?? [];
  assert.equal(msgBoxes.length, 2,
    `expected one MB_YESNO MessageBox per guard, found ${msgBoxes.length}`);

  // The prompts must not promise behaviour the instruction does not implement:
  // that mismatch is what made the broken version actively misleading.
  for (const phrase of ["返回重选目录", "返回目录页", "returning to the directory page"]) {
    assert.ok(!body.includes(phrase),
      `the guard still says "${phrase}", but Quit cancels the install instead of `
      + "going back — the text would mislead the user again");
  }
  assert.ok((body.match(/将取消本次安装/g) ?? []).length === 2,
    "both MessageBoxes must tell the user that declining cancels this install");
});

test("every guard Quit sets a non-zero error level first", () => {
  // A bare Quit in a custom page CREATOR exits 0. Measured, on this machine,
  // with NSIS 3.0.4.1 from the electron-builder cache and a marker file proving
  // Quit really took effect (the section never ran) rather than the installer
  // having completed: see logs/f11/probe2.nsi and probe3.nsi.
  //   .onInit, bare Quit                     -> 2
  //   page creator, bare Quit                -> 0
  //   page creator, SetErrorLevel 1 + Quit   -> 1
  // Position within the wizard does not change it. So the two guards — which
  // live in customPageAfterChangeDir — told any scripted caller "installed
  // successfully" after installing nothing, the automation-facing twin of F9.
  // The expected code is 1, matching the Cancel button; electron-builder's own
  // quitSuccess macro (common.nsh:78-82) deliberately sets 0 on its SUCCESS
  // path, which is why its `# avoid exit code 2` comment is about .onInit and
  // not a counter-example here.
  const page = /!macro customPageAfterChangeDir([\s\S]*?)!macroend/.exec(installerNsh);
  assert.ok(page, "customPageAfterChangeDir macro not found");
  const code = page![1]
    .split(/\r?\n/)
    .filter((l) => !/^\s*;/.test(l));

  const quitIndexes = code
    .map((l, i) => (/^\s*Quit\s*$/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(quitIndexes.length, 2,
    `expected one Quit per guard, found ${quitIndexes.length}`);

  for (const at of quitIndexes) {
    // The instruction IMMEDIATELY before each Quit must be a SetErrorLevel with
    // a non-zero value. Checking each token separately would pass on a file that
    // has both somewhere but not together, which is exactly the coupling that
    // matters: NSIS uses the error level set at the moment of Quit.
    const prev = (code[at - 1] ?? "").trim();
    const m = /^SetErrorLevel\s+(.+)$/.exec(prev);
    assert.ok(m,
      `the Quit at instruction ${at} is preceded by ${prev || "(nothing)"}, not a `
      + "SetErrorLevel — a bare Quit exits 0 from a page creator, so a declined "
      + "install reports success to its caller");
    const value = m![1].replace(/^0[xX]/, "");
    assert.ok(!/^0+$/.test(value),
      `SetErrorLevel ${m![1]} before Quit would still report success; the Cancel `
      + "button's code is 1");
  }
});
