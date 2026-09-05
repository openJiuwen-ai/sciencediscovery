// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import ssh2 from "ssh2";

import { SshConnection } from "./ssh-connection.js";

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
