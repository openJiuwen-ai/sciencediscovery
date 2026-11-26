// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";

/**
 * The account service a desktop build must reach without any local setup. It is
 * the value the repository documents as the deployment default (deployment
 * docs, `.env.example`, `docker-compose.yml`), applied by
 * `apps/desktop/vite.config.ts`; the assertion below is what fails when that
 * default is dropped and a bare build bakes an empty base URL again (#1430).
 */
const RECORDED_ACCOUNT_ORIGIN = "https://sciencediscovery.openjiuwen.com/accounts";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(desktopRoot, "../..");
const accountModule = join(desktopRoot, "src/auth/account.ts");

interface AccountsModule {
  accountsBaseUrl(): string;
  accountsConfigured(): boolean;
  huaweiSignInUrl(returnUrl: string): string;
}

/** A temp env directory with only the given files, so a developer's own
 *  `apps/desktop/.env.local` cannot decide the result of these cases. */
function envDirWith(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "desktop-accounts-env-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/**
 * Builds the real desktop module through the app's own Vite config and an
 * explicit env directory, then loads the emitted bundle. `node:test` has no
 * `import.meta.env`, so this build step — not a direct import — is what proves
 * which value a desktop bundle actually compiles in.
 */
async function buildAccountsModule(envDir: string): Promise<AccountsModule> {
  const outDir = mkdtempSync(join(tmpdir(), "desktop-accounts-build-"));
  // Node decides ESM by package type; the temp directory has no package.json.
  writeFileSync(join(outDir, "package.json"), '{ "type": "module" }\n');
  const entry = join(outDir, "entry.ts");
  writeFileSync(entry, `export { accountsBaseUrl, accountsConfigured, huaweiSignInUrl } from ${JSON.stringify(accountModule)};\n`);

  await build({
    root: desktopRoot,
    configFile: join(desktopRoot, "vite.config.ts"),
    envDir,
    logLevel: "silent",
    // UT runs before the workspace is compiled, so the shared package's
    // `dist` entry does not exist yet. Point it at the source: the package is
    // not what this test judges, and the desktop module keeps its own env
    // inlining path either way.
    resolve: {
      alias: [
        {
          find: /^@sciencediscovery\/account-session$/u,
          replacement: join(workspaceRoot, "packages/account-session/src/index.ts"),
        },
      ],
    },
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: "probe" },
    },
  });

  return (await import(pathToFileURL(join(outDir, "probe.js")).href)) as AccountsModule;
}

/** Runs `body` with `VITE_ACCOUNTS_API` unset, restoring it afterwards. */
async function withExportedAccountsApi(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const saved = process.env.VITE_ACCOUNTS_API;
  if (value === undefined) delete process.env.VITE_ACCOUNTS_API;
  else process.env.VITE_ACCOUNTS_API = value;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.VITE_ACCOUNTS_API;
    else process.env.VITE_ACCOUNTS_API = saved;
  }
}

test("a desktop build with no account-service variable resolves the recorded default", async () => {
  await withExportedAccountsApi(undefined, async () => {
    const module = await buildAccountsModule(envDirWith());

    assert.equal(module.accountsBaseUrl(), RECORDED_ACCOUNT_ORIGIN);
    assert.equal(module.accountsConfigured(), true);
    // The bug's symptom: a host-relative sign-in path that this app's own
    // static host answers with index.html instead of a sign-in page.
    const signIn = module.huaweiSignInUrl("http://127.0.0.1:4310/");
    assert.match(signIn, /^https:\/\//u);
    assert.ok(
      signIn.startsWith(`${RECORDED_ACCOUNT_ORIGIN}/v1/auth/huawei/start?`),
      `sign-in must start at the account service, got ${signIn}`,
    );
    assert.equal(new URL(signIn).origin, new URL(RECORDED_ACCOUNT_ORIGIN).origin);
  });
});

test("a local or exported override still outranks the built-in default", async () => {
  await withExportedAccountsApi(undefined, async () => {
    const module = await buildAccountsModule(
      envDirWith({ ".env.local": "VITE_ACCOUNTS_API=https://accounts.example.test/preview\n" }),
    );

    assert.equal(module.accountsBaseUrl(), "https://accounts.example.test/preview");
    assert.ok(module.huaweiSignInUrl("http://127.0.0.1:4310/").startsWith(
      "https://accounts.example.test/preview/v1/auth/huawei/start?",
    ));
  });

  await withExportedAccountsApi("https://accounts.example.test/exported", async () => {
    const module = await buildAccountsModule(envDirWith());

    assert.equal(module.accountsBaseUrl(), "https://accounts.example.test/exported");
  });
});

test("an explicit empty value is still the same-origin opt-out", async () => {
  // `.env.local` is applied after `.env`, and empty is a value, not absence.
  await withExportedAccountsApi(undefined, async () => {
    const module = await buildAccountsModule(envDirWith({ ".env.local": "VITE_ACCOUNTS_API=\n" }));

    assert.equal(module.accountsBaseUrl(), "");
    assert.equal(module.accountsConfigured(), false);
    assert.ok(module.huaweiSignInUrl("http://127.0.0.1:4310/").startsWith("/v1/auth/huawei/start?"));
  });

  // An exported variable ranks above every env file, empty included.
  await withExportedAccountsApi("", async () => {
    const module = await buildAccountsModule(envDirWith());

    assert.equal(module.accountsBaseUrl(), "");
    assert.equal(module.accountsConfigured(), false);
  });
});
