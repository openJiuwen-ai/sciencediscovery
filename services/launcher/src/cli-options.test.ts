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
import { describe, test } from "node:test";

import { defaultSettings, parseEnvFile, parseInvocation, USAGE } from "./cli-options.js";

const cwd = "/opt/sciencediscovery";

describe("launcher option parsing", () => {
  test("uses the release binary name in help output", () => {
    assert.match(USAGE, /^Usage: ScienceDiscovery <command> \[options\]/);
  });

  test("defaults bind loopback and place data beside the binary", () => {
    const settings = defaultSettings({}, cwd);
    assert.equal(settings.host, "127.0.0.1");
    assert.equal(settings.port, 4310);
    assert.equal(settings.runnerPort, 4311);
    assert.equal(settings.dataDir, "/opt/sciencediscovery/.sciencediscovery-data");
    assert.equal(settings.bwrapPath, "bwrap");
    assert.equal(settings.scientificEnvironments, true);
    assert.equal(settings.skipSandboxCheck, false);
    assert.equal(parseInvocation(["serve"], {}, cwd).usesDefaultDataDir, true);
  });

  test("environment variables seed the defaults", () => {
    const settings = defaultSettings(
      {
        SCIENCE_AGENT_BWRAP_PATH: "/usr/local/bin/bwrap",
        SCIENCE_DISCOVERY_DATA_DIR: "/srv/agent-data",
        SCIENCE_AGENT_HOST: "0.0.0.0",
        SCIENCE_AGENT_PORT: "8080",
        SCIENTIFIC_ENVS: "0",
      },
      cwd,
    );
    assert.equal(settings.host, "0.0.0.0");
    assert.equal(settings.port, 8080);
    assert.equal(settings.dataDir, "/srv/agent-data");
    assert.equal(settings.bwrapPath, "/usr/local/bin/bwrap");
    assert.equal(settings.scientificEnvironments, false);
  });

  test("reads the legacy data variable with a log and prefers the new name", () => {
    const fallbackMessages: string[] = [];
    const fallback = defaultSettings(
      { SCIENCE_AGENT_DATA_DIR: "/srv/legacy" },
      cwd,
      (message) => fallbackMessages.push(message),
    );
    assert.equal(fallback.dataDir, "/srv/legacy");
    assert.match(fallbackMessages[0] as string, /SCIENCE_AGENT_DATA_DIR is deprecated/);

    const precedenceMessages: string[] = [];
    const precedence = defaultSettings(
      {
        SCIENCE_AGENT_DATA_DIR: "/srv/legacy",
        SCIENCE_DISCOVERY_DATA_DIR: "/srv/current",
      },
      cwd,
      (message) => precedenceMessages.push(message),
    );
    assert.equal(precedence.dataDir, "/srv/current");
    assert.match(precedenceMessages[0] as string, /SCIENCE_DISCOVERY_DATA_DIR takes precedence/);
  });

  test("flags override the environment and resolve relative paths", () => {
    const messages: string[] = [];
    const invocation = parseInvocation(
      ["serve", "--data-dir", "state", "--port", "9000", "--host", "0.0.0.0", "--skip-sandbox-check"],
      { SCIENCE_AGENT_DATA_DIR: "/srv/legacy", SCIENCE_AGENT_PORT: "8080" },
      cwd,
      (message) => messages.push(message),
    );
    assert.equal(invocation.command, "serve");
    assert.equal(invocation.settings.dataDir, "/opt/sciencediscovery/state");
    assert.equal(invocation.settings.port, 9000);
    assert.equal(invocation.settings.host, "0.0.0.0");
    assert.equal(invocation.settings.skipSandboxCheck, true);
    assert.equal(invocation.usesDefaultDataDir, false);
    assert.deepEqual(messages, []);
  });

  test("maps bare help and version flags to commands", () => {
    assert.equal(parseInvocation(["--help"], {}, cwd).command, "help");
    assert.equal(parseInvocation(["-h"], {}, cwd).command, "help");
    assert.equal(parseInvocation(["--version"], {}, cwd).command, "version");
    assert.equal(parseInvocation([], {}, cwd).command, "help");
  });

  test("rejects unknown commands, unknown options and bad ports", () => {
    assert.throws(() => parseInvocation(["start"], {}, cwd), /Unknown command: start/);
    assert.throws(() => parseInvocation(["serve", "--daemon"], {}, cwd), /Unknown option: --daemon/);
    assert.throws(() => parseInvocation(["serve", "--port", "70000"], {}, cwd), /between 0 and 65535/);
    assert.throws(() => parseInvocation(["serve", "--port"], {}, cwd), /requires a value/);
  });

  test("extract demands a destination", () => {
    assert.throws(() => parseInvocation(["extract"], {}, cwd), /requires --to/);
    assert.equal(parseInvocation(["extract", "--to", "out"], {}, cwd).extractTo, "/opt/sciencediscovery/out");
  });
});

describe("env file parsing", () => {
  test("reads assignments, comments and quoting", () => {
    const values = parseEnvFile(
      [
        "# a comment",
        "",
        "SCIENCE_AGENT_PORT=8080",
        'export SCIENCE_AGENT_AUTH_TOKEN="quoted secret"',
        "SCIENCE_AGENT_HOST='0.0.0.0'",
        "SCIENCE_AGENT_DATA_DIR=/srv/data   # trailing comment",
        "not an assignment",
      ].join("\n"),
    );
    assert.deepEqual(values, {
      SCIENCE_AGENT_AUTH_TOKEN: "quoted secret",
      SCIENCE_AGENT_DATA_DIR: "/srv/data",
      SCIENCE_AGENT_HOST: "0.0.0.0",
      SCIENCE_AGENT_PORT: "8080",
    });
  });
});
