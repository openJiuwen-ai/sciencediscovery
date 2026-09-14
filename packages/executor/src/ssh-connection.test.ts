// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";

import { hostKeyFingerprint, SshConnection, SshHostKeyUntrustedError, type SshCredentials } from "./ssh-connection.js";
import { generateSshKeyPair } from "./ssh-keys.js";

test("Runner file transfer uses the authenticated SFTP session and fails on disconnect", async (context) => {
  let client: ssh2.Client;
  context.mock.method(ssh2.Client.prototype, "connect", function (this: ssh2.Client) {
    client = this; queueMicrotask(() => this.emit("ready")); return this;
  });
  context.mock.method(ssh2.Client.prototype, "end", function (this: ssh2.Client) { return this; });
  let complete: (error?: Error) => void = () => undefined;
  let ended = 0;
  const transfer = Object.assign(new EventEmitter(), {
    end: () => { ended++; },
    fastPut: (source: string, destination: string, options: { mode: number }, done: (error?: Error) => void) => {
      assert.equal(source, "product-runner"); assert.equal(destination, "/fixture/.upload-runner");
      assert.equal(options.mode, 0o700); complete = done;
    },
  });
  context.mock.method(ssh2.Client.prototype, "sftp", (done: (error: undefined, sftp: unknown) => void) => done(undefined, transfer));
  const connection = await SshConnection.open({ destination: "fixture", credentials: { username: "operator", password: randomBytes(16).toString("hex") } });
  const first = connection.upload("product-runner", "/fixture/.upload-runner");
  complete(); await first;
  assert.equal(ended, 1);
  const failed = assert.rejects(connection.upload("product-runner", "/fixture/.upload-runner"), /connection closed during Runner binary transfer/);
  client!.emit("close"); await failed;
  complete(new Error("late failure"));
  assert.equal(ended, 2);
});

test("authentication diagnostics reflect actual SSH protocol exchanges without exposing credentials", async (context) => {
  // ssh2 1.17 keygen strips leading zero public-key bytes; use the same
  // fixed-width OpenSSH encoding as product-generated keys instead.
  const hostKeys = generateSshKeyPair("authentication-test-host");
  const parsed = ssh2.utils.parseKey(hostKeys.privateKey);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  const trustedHostKey = { algorithm: "ssh-ed25519", fingerprint: hostKeyFingerprint(parsed.getPublicSSH()) };
  const password = ` ${randomBytes(24).toString("hex")} `;
  const privateKey = generateSshKeyPair("authentication-test-client").privateKey;
  const passphrase = randomBytes(24).toString("hex");
  const credentials: SshCredentials = { username: "operator", password, privateKey, passphrase };

  for (const scenario of ["password rejected", "key rejected", "interactive accepted", "interactive rejected", "password change", "untrusted key"] as const) {
    await context.test(scenario, { timeout: 5_000 }, async (t) => {
      const attempts: string[] = [];
      const connections = new Set<ssh2.Connection>();
      const offered: ssh2.AuthenticationType[] = scenario === "key rejected" ? ["publickey"] : scenario.startsWith("interactive") ? ["keyboard-interactive"] : ["publickey", "password"];
      const server = new ssh2.Server({
        hostKeys: [hostKeys.privateKey],
        banner: `Authorized users only. password=${password.trim()} token=${randomBytes(24).toString("hex")} ${privateKey} ${passphrase} ${"notice ".repeat(100)}`,
      }, (connection) => {
        connections.add(connection);
        connection.on("error", () => undefined);
        connection.on("close", () => connections.delete(connection));
        connection.on("authentication", (auth) => {
          attempts.push(auth.method);
          assert.equal(auth.username, "operator");
          if (auth.method === "password") {
            assert.ok(auth.password === password, "password bytes are preserved");
            if (scenario === "password change") {
              auth.requestChange(`Password expired; ${password} ${passphrase}`, () => assert.fail("must not change password automatically"));
              return;
            }
          }
          if (auth.method === "keyboard-interactive") {
            auth.prompt([{ prompt: "Password:", echo: false }], (answers) => {
              assert.ok(answers.length === 1 && answers[0] === password, "interactive answer preserves saved password");
              if (scenario === "interactive accepted") auth.accept();
              else auth.reject(offered);
            });
            return;
          }
          auth.reject(offered);
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      t.after(async () => {
        for (const connection of connections) connection.end();
        await new Promise<void>((done) => server.close(() => done()));
      });
      const port = (server.address() as AddressInfo).port;
      const target = {
        destination: "127.0.0.1", port,
        credentials: scenario === "key rejected" ? { username: credentials.username, privateKey } : { username: credentials.username, password, passphrase },
        ...(scenario === "untrusted key" ? {} : { trustedHostKey }),
      };
      if (scenario === "interactive accepted") {
        const connection = await SshConnection.open(target);
        connection.close();
        assert.deepEqual(attempts, ["none", "keyboard-interactive"]);
        return;
      }
      await assert.rejects(SshConnection.open(target), (error: Error) => {
        if (scenario === "untrusted key") {
          assert.ok(error instanceof SshHostKeyUntrustedError);
          assert.equal(attempts.length, 0);
          return true;
        }
        assert.ok(error.message.includes(`operator@127.0.0.1:${port}`));
        assert.ok(error.message.includes(`Server offered: ${offered.join(", ")}.`));
        assert.ok(error.message.includes(`Actually tried: ${attempts.join(", ")} (none is method discovery).`));
        assert.ok(error.message.includes(scenario === "key rejected" ? "password no; key yes" : "password yes; key no"));
        assert.ok(error.message.includes("Server banner: Authorized users only."));
        for (const secret of [password.trim(), privateKey, passphrase]) assert.ok(!error.message.includes(secret), "diagnostics exclude credentials");
        assert.ok(!error.message.includes("BEGIN OPENSSH PRIVATE KEY"));
        assert.ok(error.message.length < 2_000);
        if (scenario === "password change") assert.match(error.message, /requires a password change/);
        else assert.match(error.message, /server did not accept authentication/);
        return true;
      });
    });
  }
});

test("SSH errors after ready fail only that connection and reject pending commands", async (context) => {
  const clients: ssh2.Client[] = [];
  const configs: ssh2.ConnectConfig[] = [];
  context.mock.method(ssh2.Client.prototype, "connect", function (this: ssh2.Client, config: ssh2.ConnectConfig) {
    clients.push(this);
    configs.push(config);
    queueMicrotask(() => this.emit("ready"));
    return this;
  });
  context.mock.method(ssh2.Client.prototype, "destroy", function (this: ssh2.Client) {
    this.emit("close");
    return this;
  });
  context.mock.method(ssh2.Client.prototype, "exec", function (this: ssh2.Client) { return this; });
  const target = { credentials: { username: "test", password: "test" }, destination: "fixture-only" };
  const connection = await SshConnection.open(target);
  const other = await SshConnection.open(target);
  let closedWith: Error | undefined;
  let otherClosed = false;
  connection.onClose((error) => { closedWith = error; });
  other.onClose(() => { otherClosed = true; });
  const failure = new Error("synthetic connection reset");
  const pending = assert.rejects(connection.run("true", 60_000), failure);
  assert.doesNotThrow(() => clients[0]!.emit("error", failure));
  await pending;
  assert.equal(closedWith, failure);
  assert.equal(otherClosed, false);
  assert.doesNotThrow(() => clients[0]!.emit("error", new Error("late error")));
  assert.equal(configs[0]!.keepaliveInterval, 15_000);
  assert.equal(configs[0]!.keepaliveCountMax, 3);
});
