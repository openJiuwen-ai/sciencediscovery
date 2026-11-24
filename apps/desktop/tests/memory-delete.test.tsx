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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import React from "react";

import { ApiRequestError } from "../src/api/client.js";
import type { ApiClient } from "../src/api/client.js";
import type { ComposerReference, MemoryGraphHit } from "../src/api/types.js";
import { MarkdownProse } from "../src/MarkdownProse.js";
import { TEXT } from "../src/text.js";
import { ConfirmDialog } from "../src/views/ConfirmDialog.js";
import { MemoryCardDialog } from "../src/views/MemoryCardDialog.js";
import { StubClient } from "./api-stub.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const evidenceReference: ComposerReference = {
  id: "evidence-1",
  kind: "evidence",
  label: "evidence1",
};
const artifactReference: ComposerReference = {
  id: "artifact-1",
  kind: "artifact",
  label: "artifact1",
};

function evidenceHit(): MemoryGraphHit {
  return {
    createdAt: "2026-10-01T10:00:00.000Z",
    excerpt: "Methane conversion rose to 92%",
    extra: {
      content: "Methane conversion rose to 92% at 450 C",
      evidence_type: "measurement",
      locator: "Figure 2",
    },
    id: "evidence-1",
    label: "Evidence",
    sessionId: "session-1",
  };
}

function artifactHit(): MemoryGraphHit {
  return {
    createdAt: "2026-10-01T10:00:00.000Z",
    excerpt: "report.md",
    extra: { artifact_id: "artifact-1", logical_name: "report.md", version: 1 },
    id: "artifact-1#v1",
    label: "Artifact",
    sessionId: "session-1",
  };
}

/** The dialog registers document-level escape/dismissal listeners, but the
 *  suite mounts React without a DOM. No `body` on purpose: the card then draws
 *  inline instead of portalling, so react-test-renderer can inspect it. */
async function withDocument<T>(run: () => Promise<T>): Promise<T> {
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = { addEventListener() {}, removeEventListener() {} };
  try {
    return await run();
  } finally {
    if (previous === undefined) delete globals.document;
    else globals.document = previous;
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(
  client: ApiClient,
  reference: ComposerReference,
  onClose: () => void,
): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <MemoryCardDialog
        client={client}
        onClose={onClose}
        onOpenSettings={() => {}}
        reference={reference}
      />,
    );
  });
  await act(async () => { await settle(); });
  return view;
}

function deleteButton(view: ReactTestRenderer) {
  return view.root.findAllByType("button")
    .find((button) => button.props.className === "danger-button memory-delete-button");
}

async function confirmDelete(view: ReactTestRenderer): Promise<void> {
  const confirmation = view.root.findByType(ConfirmDialog);
  const accept = confirmation.findAllByType("button")
    .find((button) => button.props.className === "primary-button");
  assert.ok(accept, "the confirmation has an accept button");
  await act(async () => {
    accept!.props.onClick();
    await settle();
  });
}

describe("deleting one evidence record from its card", () => {
  it("offers delete only for a resolved Evidence and names the record in the confirmation", async () => {
    await withDocument(async () => {
      let closed = 0;
      const stub = new StubClient().reply({ hits: [evidenceHit()], total: 1, truncated: false });
      const view = await mount(stub.asClient(), evidenceReference, () => { closed += 1; });
      try {
        const button = deleteButton(view);
        assert.ok(button, "a ready Evidence offers the delete action");
        assert.equal(button!.props["aria-label"], TEXT.memory.deleteAction);

        await act(async () => { button!.props.onClick(); });
        const markup = JSON.stringify(view.toJSON());
        assert.ok(markup.includes(TEXT.memory.deleteConfirmTitle));
        assert.ok(markup.includes("Methane conversion rose to 92% at 450 C"), "the record is named");
        assert.ok(markup.includes("引用会显示"), "the citation consequence is stated");
        assert.equal(stub.calls.length, 1, "opening the confirmation sends no request");
        assert.equal(closed, 0);
      } finally {
        await act(async () => { view.unmount(); });
      }
    });
  });

  it("sends nothing on cancel and closes only after one confirmed delete", async () => {
    await withDocument(async () => {
      let closed = 0;
      const stub = new StubClient()
        .reply({ hits: [evidenceHit()], total: 1, truncated: false })
        .reply({ status: "healthy", deleted: 1 });
      const view = await mount(stub.asClient(), evidenceReference, () => { closed += 1; });
      try {
        await act(async () => { deleteButton(view)!.props.onClick(); });
        const confirmation = view.root.findByType(ConfirmDialog);
        const cancel = confirmation.findAllByType("button")
          .find((button) => button.props.className === "secondary-button");
        assert.ok(cancel, "the confirmation can be cancelled");
        await act(async () => { cancel!.props.onClick(); });
        assert.equal(stub.calls.length, 1, "cancel sends no request");
        assert.equal(closed, 0);

        await act(async () => { deleteButton(view)!.props.onClick(); });
        await confirmDelete(view);

        assert.equal(stub.calls.length, 2, "one confirmed delete is exactly one request");
        assert.equal(stub.calls[1]!.path, "/api/memory/delete/node");
        assert.deepEqual(JSON.parse(String(stub.calls[1]!.init.body)), {
          node_id: "evidence-1",
          node_type: "Evidence",
          session_id: "session-1",
        });
        assert.equal(closed, 1, "the card closes after the delete succeeds");
      } finally {
        await act(async () => { view.unmount(); });
      }
    });
  });

  it("keeps the card open and shows the real error when the delete fails", async () => {
    await withDocument(async () => {
      let closed = 0;
      const stub = new StubClient()
        .reply({ hits: [evidenceHit()], total: 1, truncated: false })
        .fail(new ApiRequestError("memory graph unreachable", 502, "memory_graph_unreachable"));
      const view = await mount(stub.asClient(), evidenceReference, () => { closed += 1; });
      try {
        await act(async () => { deleteButton(view)!.props.onClick(); });
        await confirmDelete(view);

        const markup = JSON.stringify(view.toJSON());
        assert.equal(closed, 0, "a failed delete must not close the card");
        assert.equal(stub.calls.length, 2);
        assert.ok(markup.includes("memory graph unreachable"), "the sidecar error is shown");
        assert.ok(markup.includes(TEXT.memory.deleteAction), "the record can be tried again");
        assert.ok(!markup.includes(TEXT.memory.notFoundTitle), "a failure is not reported as missing");
      } finally {
        await act(async () => { view.unmount(); });
      }
    });
  });

  it("gives a refused internal token its credential copy, not a timeout", async () => {
    // Issue #1352's split: the sidecar answered and rejected the token. The
    // card must not read as "unreachable, try again", which is what the
    // delete path used to say for every non-404/400 answer.
    await withDocument(async () => {
      let closed = 0;
      const stub = new StubClient()
        .reply({ hits: [evidenceHit()], total: 1, truncated: false })
        .fail(new ApiRequestError("memory graph rejected the internal token", 502, "memory_graph_unauthorized"));
      const view = await mount(stub.asClient(), evidenceReference, () => { closed += 1; });
      try {
        await act(async () => { deleteButton(view)!.props.onClick(); });
        await confirmDelete(view);

        const markup = JSON.stringify(view.toJSON());
        assert.equal(closed, 0);
        assert.ok(markup.includes(TEXT.memory.authBody), "the credential guidance is shown");
        assert.ok(!markup.includes(TEXT.memory.unreachableBody), "a rejected token is not a timeout");
        assert.ok(!markup.includes(TEXT.memory.notFoundTitle), "and it is not a missing record");
      } finally {
        await act(async () => { view.unmount(); });
      }
    });
  });

  it("leaves Artifact cards and missing records without a delete action", async () => {
    await withDocument(async () => {
      const artifact = new StubClient().reply({ hits: [artifactHit()], total: 1, truncated: false });
      const artifactView = await mount(artifact.asClient(), artifactReference, () => {});
      try {
        assert.equal(deleteButton(artifactView), undefined, "Artifact goes through ArtifactDialog");
      } finally {
        await act(async () => { artifactView.unmount(); });
      }

      const missing = new StubClient().reply({ hits: [], total: 0, truncated: false });
      const missingView = await mount(missing.asClient(), evidenceReference, () => {});
      try {
        const markup = JSON.stringify(missingView.toJSON());
        assert.ok(markup.includes(TEXT.memory.notFoundTitle));
        assert.equal(deleteButton(missingView), undefined);
      } finally {
        await act(async () => { missingView.unmount(); });
      }
    });
  });
});

describe("a report whose cited record was deleted", () => {
  it("still renders its citation chip, and the chip opens the card's not-found state", async () => {
    let opened: ComposerReference | undefined;
    let prose!: ReactTestRenderer;
    await act(async () => {
      prose = create(
        <MarkdownProse
          onReferenceClick={(reference) => { opened = reference; }}
          references={[evidenceReference]}
        >
          {"The rate rose [evidence1]."}
        </MarkdownProse>,
      );
    });
    try {
      const rendered = JSON.stringify(prose.toJSON());
      assert.match(rendered, /graph-chip/);
      assert.ok(rendered.includes("evidence1"));
      const chip = prose.root.findAllByType("button")
        .find((button) => String(button.props.className).includes("graph-chip"));
      assert.ok(chip, "the citation is still a chip");
      await act(async () => { chip!.props.onClick(); });
      assert.deepEqual(opened, evidenceReference);
    } finally {
      await act(async () => { prose.unmount(); });
    }

    await withDocument(async () => {
      const stub = new StubClient().reply({ hits: [], total: 0, truncated: false });
      const view = await mount(stub.asClient(), evidenceReference, () => {});
      try {
        const markup = JSON.stringify(view.toJSON());
        assert.ok(markup.includes(TEXT.memory.notFoundTitle));
        assert.ok(markup.includes(TEXT.memory.notFoundBody));
        assert.equal(deleteButton(view), undefined);
      } finally {
        await act(async () => { view.unmount(); });
      }
    });
  });
});
