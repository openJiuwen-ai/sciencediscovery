// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import type { SkillDescriptor } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { buildSkillFileTree, SkillWorkspaceDialog } from "../src/SkillWorkspaceDialog.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("groups package resources into a collapsible directory tree", () => {
  assert.deepEqual(buildSkillFileTree([
    "scripts/nested/helper.py",
    "SKILL.md",
    "references/guide.md",
    "scripts/run.py",
  ]), [
    { children: [], fileCount: 1, kind: "file", name: "SKILL.md", path: "SKILL.md" },
    {
      children: [{ children: [], fileCount: 1, kind: "file", name: "guide.md", path: "references/guide.md" }],
      fileCount: 1,
      kind: "directory",
      name: "references",
      path: "references",
    },
    {
      children: [
        {
          children: [{ children: [], fileCount: 1, kind: "file", name: "helper.py", path: "scripts/nested/helper.py" }],
          fileCount: 1,
          kind: "directory",
          name: "nested",
          path: "scripts/nested",
        },
        { children: [], fileCount: 1, kind: "file", name: "run.py", path: "scripts/run.py" },
      ],
      fileCount: 2,
      kind: "directory",
      name: "scripts",
      path: "scripts",
    },
  ]);
});

test("renders a four-pane Skill explorer with pending and installed Skills", () => {
  const managed = {
    currentRevision: 3,
    description: "Managed workflow",
    diagnostics: [],
    hash: "a".repeat(64),
    id: "managed-skill",
    name: "managed-skill",
    readOnly: false,
    resourceSummary: { bytes: 10, files: 1, kinds: { asset: 0, other: 0, reference: 1, script: 0 } },
    source: "managed",
    version: "1.0.0",
  } satisfies SkillDescriptor;
  const html = renderToStaticMarkup(createElement(SkillWorkspaceDialog, {
    client: {} as ApiClient,
    drafts: [
      { createdAt: "2026-08-20T00:00:00.000Z", draftId: "draft-1", fileCount: 1, name: "pending-skill", updatedAt: "2026-08-20T00:01:00.000Z" },
      { createdAt: "2026-08-20T00:02:00.000Z", draftId: "draft-2", fileCount: 1, name: "pending-skill-lite", updatedAt: "2026-08-20T00:03:00.000Z" },
    ],
    onCatalogChange: () => undefined,
    onClose: () => undefined,
    onDraftsChange: () => undefined,
    onError: () => undefined,
    onReviewDraft: () => undefined,
    skills: [managed],
  }));

  assert.match(html, /Skills Explorer/);
  assert.match(html, /managed-skill/);
  assert.match(html, /pending-skill/);
  assert.match(html, /Package files/);
  assert.match(html, /Version history/);
  assert.match(html, /Combine drafts as versions/);
  assert.match(html, /Compare/);
  assert.match(html, /Read-only/);
  assert.match(html, /Delete Skill/);
  assert.match(html, /aria-label="Collapse Skills sidebar"/);
  assert.match(html, /aria-label="Collapse package files sidebar"/);
  assert.match(html, /aria-label="Collapse version history sidebar"/);
  assert.match(html, /aria-label="Filter Skills"/);
  assert.match(html, /Drafts/);
});

test("opens pending Skills in edit mode and presents a prominent draft editor entry", async () => {
  const draft = {
    createdAt: "2026-08-20T00:00:00.000Z",
    draftId: "draft-edit-1",
    fileCount: 1,
    name: "pending-edit-skill",
    updatedAt: "2026-08-20T00:01:00.000Z",
  };
  const opened: string[] = [];
  const client = {
    getSkillVersion: async (skillId: string, versionId: string) => ({
      fileCount: 1,
      files: [{ content: `---\nname: ${skillId}\ndescription: Test\n---\n\n# Workflow`, path: "SKILL.md", size: 59 }],
      id: versionId,
      kind: "agent-proposal" as const,
      label: "Current pending proposal",
      skillId,
    }),
    listSkillVersions: async () => [{
      fileCount: 1,
      id: "proposal:draft-edit-1",
      kind: "agent-proposal" as const,
      label: "Current pending proposal",
    }],
  } as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SkillWorkspaceDialog, {
      client,
      drafts: [draft],
      onCatalogChange: () => undefined,
      onClose: () => undefined,
      onDraftsChange: () => undefined,
      onError: (message) => assert.fail(message),
      onReviewDraft: (draftId) => opened.push(draftId),
      skills: [],
    }));
  });

  const editMode = renderer!.root.findAllByType("button").find((button) => button.children.join("") === "Edit draft");
  assert.ok(editMode);
  assert.equal(editMode.props.className, "active");
  assert.equal(renderer!.root.findAllByProps({ className: "skill-workspace-draft-edit" }).length, 1);
  const reviewEntry = renderer!.root.findByProps({ className: "skill-workspace-review" });
  assert.equal(reviewEntry.findByType("strong").children.join(""), "Edit & review draft");
  await act(async () => reviewEntry.props.onClick());
  assert.deepEqual(opened, [draft.draftId]);
  await act(async () => renderer!.unmount());
});

test("filters the Explorer catalog down to pending drafts", async () => {
  const managed = {
    currentRevision: 1,
    description: "Installed workflow",
    diagnostics: [],
    hash: "d".repeat(64),
    id: "installed-only",
    name: "installed-only",
    readOnly: false,
    resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
    source: "managed",
    version: "1.0.0",
  } satisfies SkillDescriptor;
  const draft = { createdAt: "2026-08-20T00:00:00.000Z", draftId: "draft-filter", fileCount: 1, name: "draft-only", updatedAt: "2026-08-20T00:01:00.000Z" };
  const client = { listSkillVersions: async () => [] } as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SkillWorkspaceDialog, {
      client,
      drafts: [draft],
      initialSkillId: managed.id,
      onCatalogChange: () => undefined,
      onClose: () => undefined,
      onDraftsChange: () => undefined,
      onError: (message) => assert.fail(message),
      onReviewDraft: () => undefined,
      skills: [managed],
    }));
  });

  const filter = renderer!.root.findByProps({ "aria-label": "Filter Skills" });
  await act(async () => filter.findAllByType("button")[1]!.props.onClick());
  const names = renderer!.root.findByProps({ className: "skill-workspace-skill-list" })
    .findAllByType("strong").map((strong) => strong.children.join(""));
  assert.deepEqual(names, [draft.name]);
  await act(async () => renderer!.unmount());
});

test("switching Skills never requests the previous Skill's version and managed files stay editable", async () => {
  const builtIn = {
    currentRevision: 1,
    description: "Built-in workflow",
    diagnostics: [],
    hash: "b".repeat(64),
    id: "a-built-in",
    name: "a-built-in",
    readOnly: true,
    resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
    source: "built-in",
    version: "1.0.0",
  } satisfies SkillDescriptor;
  const managed = {
    ...builtIn,
    currentRevision: 2,
    description: "Managed workflow",
    id: "b-managed",
    name: "b-managed",
    readOnly: false,
    source: "managed",
  } satisfies SkillDescriptor;
  const requests: string[] = [];
  const errors: string[] = [];
  const client = {
    getSkillVersion: async (skillId: string, versionId: string) => {
      requests.push(`${skillId}@${versionId}`);
      const expected = skillId === builtIn.id ? "built-in" : "revision:2";
      if (versionId !== expected) throw new Error(`stale version ${skillId}@${versionId}`);
      return {
        current: true,
        fileCount: 1,
        files: [{ content: `---\nname: ${skillId}\ndescription: Test\n---\n\n# Workflow`, path: "SKILL.md", size: 59 }],
        id: versionId,
        kind: skillId === builtIn.id ? "built-in" as const : "managed-revision" as const,
        label: versionId,
        revision: skillId === builtIn.id ? 1 : 2,
        skillId,
      };
    },
    listSkillVersions: async (skillId: string) => [{
      current: true,
      fileCount: 1,
      id: skillId === builtIn.id ? "built-in" : "revision:2",
      kind: skillId === builtIn.id ? "built-in" as const : "managed-revision" as const,
      label: skillId === builtIn.id ? "Built-in" : "Installed revision r2",
      revision: skillId === builtIn.id ? 1 : 2,
    }],
  } as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SkillWorkspaceDialog, {
      client,
      drafts: [],
      initialSkillId: builtIn.id,
      onCatalogChange: () => undefined,
      onClose: () => undefined,
      onDraftsChange: () => undefined,
      onError: (message) => errors.push(message),
      onReviewDraft: () => undefined,
      skills: [builtIn, managed],
    }));
  });
  const managedButton = renderer!.root.findAllByType("button").find((button) => (
    button.findAllByType("strong").some((strong) => strong.children.join("") === managed.id)
  ));
  assert.ok(managedButton);
  await act(async () => managedButton.props.onClick());

  assert.ok(requests.includes("a-built-in@built-in"));
  assert.ok(requests.includes("b-managed@revision:2"));
  assert.ok(!requests.includes("b-managed@built-in"));
  assert.deepEqual(errors, []);
  assert.equal(renderer!.root.findByProps({ "aria-label": "Edit Skill file SKILL.md" }).props.disabled, false);
  await act(async () => renderer!.unmount());
});

test("deletes a managed Skill from the Explorer after reference check and typed confirmation", async () => {
  const managed = {
    currentRevision: 2,
    description: "Managed workflow",
    diagnostics: [],
    hash: "c".repeat(64),
    id: "managed-delete-me",
    name: "managed-delete-me",
    readOnly: false,
    resourceSummary: { bytes: 59, files: 1, kinds: { asset: 0, other: 0, reference: 1, script: 0 } },
    source: "managed",
    version: "1.0.0",
  } satisfies SkillDescriptor;
  const deleted: string[] = [];
  let catalogAfterDelete: SkillDescriptor[] | undefined;
  const client = {
    deleteSkill: async (skillId: string) => {
      deleted.push(skillId);
      return { deleted: skillId };
    },
    getSkillDeletionImpact: async (skillId: string) => ({ references: [], skillId }),
    getSkillVersion: async (skillId: string, versionId: string) => ({
      current: true,
      fileCount: 1,
      files: [{ content: `---\nname: ${skillId}\ndescription: Test\n---\n\n# Workflow`, path: "SKILL.md", size: 59 }],
      id: versionId,
      kind: "managed-revision" as const,
      label: "Installed revision r2",
      revision: 2,
      skillId,
    }),
    listSkillVersions: async () => [{
      current: true,
      fileCount: 1,
      id: "revision:2",
      kind: "managed-revision" as const,
      label: "Installed revision r2",
      revision: 2,
    }],
    listSkills: async () => [],
  } as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SkillWorkspaceDialog, {
      client,
      drafts: [],
      initialSkillId: managed.id,
      onCatalogChange: (next) => { catalogAfterDelete = next; },
      onClose: () => undefined,
      onDraftsChange: () => undefined,
      onError: (message) => assert.fail(message),
      onReviewDraft: () => undefined,
      skills: [managed],
    }));
  });

  const deleteAction = renderer!.root.findAllByType("button").find((button) => button.children.join("") === "Delete Skill");
  assert.ok(deleteAction);
  await act(async () => {
    deleteAction.props.onClick();
    await Promise.resolve();
  });
  const dialog = renderer!.root.findByProps({ "aria-label": `Delete Skill ${managed.id}` });
  const confirmation = dialog.findByType("input");
  await act(async () => confirmation.props.onChange({ target: { value: managed.id } }));
  const confirmButton = dialog.findAllByType("button").find((button) => button.children.join("") === "Delete Skill");
  assert.ok(confirmButton);
  assert.equal(confirmButton.props.disabled, false);
  await act(async () => {
    confirmButton.props.onClick();
    await Promise.resolve();
  });

  assert.deepEqual(deleted, [managed.id]);
  assert.deepEqual(catalogAfterDelete, []);
  await act(async () => renderer!.unmount());
});
