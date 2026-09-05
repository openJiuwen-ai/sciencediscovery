// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SshKeyFileListing } from "@sciencediscovery/schema";
import type { ApiClient } from "../src/api.js";
import { SshKeyFileField } from "../src/SshKeyFileField.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const directory = "fixture-folder";
const listing: SshKeyFileListing = { directory, parentDirectory: "fixture-parent", nextOffset: null,
  entries: [{ name: "ssh keys", path: "fixture-folder/ssh keys", kind: "directory" }, { name: "id_ed25519", path: "fixture-folder/id_ed25519", kind: "file" }] };

test("Browse selects an application-machine path and cancellation never changes credentials", async () => {
  const selected: string[] = [];
  const requests: Array<string | undefined> = [];
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(SshKeyFileField, {
    client: { listSshKeyFiles: async (path?: string) => { requests.push(path); return listing; } } as ApiClient,
    label: "Private key file", value: "", placeholder: "~/.ssh/id_ed25519", onChange: (path) => selected.push(path),
  })); });
  const click = async (label: string) => {
    const button = renderer!.root.findAllByType("button").find((node) => node.children.filter((child) => typeof child === "string").join("") === label);
    assert.ok(button);
    await act(async () => button.props.onClick());
  };
  await click("Browse");
  assert.deepEqual(requests, [undefined]);
  assert.match(JSON.stringify(renderer!.toJSON()), /machine running ScienceDiscovery/);
  const entry = (name: string) => renderer!.root.findAllByType("button").find((node) => node.findAllByType("span").some((span) => span.children.join("") === name))!;
  await act(async () => entry("ssh keys").props.onClick());
  assert.equal(requests.at(-1), "fixture-folder/ssh keys");
  await act(async () => entry("id_ed25519").props.onClick());
  assert.deepEqual(selected, ["fixture-folder/id_ed25519"]);
  assert.equal(renderer!.root.findAllByType("section").length, 0);
  await click("Browse");
  await click("Cancel selection");
  assert.equal(selected.length, 1);
  await act(async () => renderer!.unmount());
});

test("closed picker ignores a late response and listing errors stay in the picker", async () => {
  let resolveListing: (value: SshKeyFileListing) => void = () => undefined;
  let fail = false;
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(SshKeyFileField, {
    client: { listSshKeyFiles: () => fail ? Promise.reject(new Error("Directory unavailable")) : new Promise<SshKeyFileListing>((done) => { resolveListing = done; }) } as ApiClient,
    label: "Private key file", value: "original", placeholder: "", onChange: () => assert.fail("must not select"),
  })); });
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  await act(async () => renderer!.root.findAllByType("button").find((button) => button.children.join("") === "Cancel selection")!.props.onClick());
  await act(async () => resolveListing(listing));
  assert.equal(renderer!.root.findAllByType("section").length, 0);
  fail = true;
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  assert.match(renderer!.root.findByProps({ role: "alert" }).children.join(""), /Directory unavailable/);
  assert.equal(renderer!.root.findAllByType("input")[0]!.props.value, "original");
  await act(async () => renderer!.unmount());
});
