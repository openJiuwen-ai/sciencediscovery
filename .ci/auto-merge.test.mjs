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

// The auto-merge pipeline cannot be rehearsed: it only runs from a real
// `/merge` comment on a real merge request, and it merges. What can be
// rehearsed is every decision it makes before that call, so the helper's
// parsing half is exercised here against fixtures, and the pipeline is checked
// against the script it invokes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const helper = join(repositoryRoot, ".ci", "gitcode-merge-request.py");
const autoMergeScript = join(repositoryRoot, ".ci", "codearts-auto-merge.sh");
const pipelineFile = join(
  repositoryRoot, ".codearts", "workflow", "codearts-auto-merge-pipeline.yml");
const testRoot = join(repositoryRoot, ".tmp", "auto-merge-tests");

function parse(command, document) {
  return spawnSync("python3", [helper, command], {
    encoding: "utf8",
    input: JSON.stringify(document),
  });
}

function lines(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\n$/, "").split("\n");
}

function comment(id, login, body, createdAt) {
  return { id, body, created_at: createdAt, user: { login } };
}

test("the newest /merge comment is the one that authorizes the merge", () => {
  const result = parse("parse-merge-command", [
    comment(1, "alice", "/merge", "2026-09-07T10:00:00+08:00"),
    comment(2, "bot", "✅ 自动合并完成", "2026-09-07T10:01:00+08:00"),
    comment(3, "bob", "/merge please", "2026-09-07T10:02:00+08:00"),
  ]);
  assert.deepEqual(lines(result), ["bob", "3"]);
});

test("a comment that only mentions /merge does not authorize anything", () => {
  const result = parse("parse-merge-command", [
    comment(1, "alice", "/merge", "2026-09-07T10:00:00+08:00"),
    comment(2, "mallory", "run /merge when this is ready", "2026-09-07T10:05:00+08:00"),
  ]);
  assert.deepEqual(lines(result), ["alice", "1"]);
});

test("a merge request without a /merge comment is refused, not guessed at", () => {
  const result = parse("parse-merge-command", [
    comment(1, "alice", "looks good", "2026-09-07T10:00:00+08:00"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no \/merge comment/);
});

test("an anonymous /merge comment cannot stand in for a CODEOWNER", () => {
  const result = parse("parse-merge-command", [
    { id: 1, body: "/merge", created_at: "2026-09-07T10:00:00+08:00", user: {} },
  ]);
  assert.notEqual(result.status, 0);
});

test("the merge request's live state is read field by field", () => {
  const result = parse("parse-pr", {
    state: "open",
    base: { ref: "main" },
    head: { sha: "AABBCCDDEEFF00112233445566778899AABBCCDD" },
    mergeable: true,
    draft: false,
    merged: false,
    mergeable_state: {
      approval_reviewers_required_passed: true,
      approval_approvers_required_passed: true,
    },
    assignees: [{ login: "alice" }],
  });
  assert.deepEqual(lines(result), [
    "open",
    "main",
    "aabbccddeeff00112233445566778899aabbccdd",
    "true",
    "false",
    "false",
    "true",
    "alice",
  ]);
});

test("one unmet approval rule marks the whole merge request unapproved", () => {
  const result = parse("parse-pr", {
    state: "open",
    base: { ref: "main" },
    head: { sha: "a".repeat(40) },
    mergeable: null,
    mergeable_state: {
      approval_reviewers_required_passed: true,
      approval_approvers_required_passed: false,
    },
  });
  const fields = lines(result);
  assert.equal(fields[3], "null", "an unknown mergeable state must not read as false");
  assert.equal(fields[6], "false");
});

test("a merge request that reports no approval rules is not reported as unapproved", () => {
  const result = parse("parse-pr", {
    state: "open", base: { ref: "main" }, head: { sha: "b".repeat(40) },
  });
  assert.equal(lines(result)[6], "unknown");
});

test("the pipeline runs the merge on a build task, not on a pipeline executor", async () => {
  const pipeline = await readFile(pipelineFile, "utf8");
  assert.match(pipeline, /uses: official_devcloud_cloudBuild/);
  assert.doesNotMatch(pipeline, /official_shell_plugin|official_git_clone/);
  // The merge request must hear a refusal as a failed run, so this task is the
  // one kind that reports the script's own status.
  assert.match(pipeline, /STRICT_EXIT: "1"/);
  assert.match(pipeline, /SH_FILE_PATH: \.ci\/codearts-auto-merge\.sh/);
  // The script is the one on the authority branch, not the one in the merge
  // request: a merge request must not be able to edit what merges it.
  assert.match(pipeline, /GIT_REF: refs\/heads\/main/);
  assert.match(pipeline, /merge_comment: \/merge/);
});

test("the pipeline names a real build task", async () => {
  const pipeline = await readFile(pipelineFile, "utf8");
  const jobId = pipeline.match(/^ +jobId: (.+)$/m);
  assert.ok(jobId, "the cloudBuild step must name a build task");
  assert.match(
    jobId[1], /^[0-9a-f]{32}$/,
    "the CodeArts build task id is 32 hex characters; a placeholder must never reach main");
});

// A fake for .ci/gitcode-merge-request.py. It answers from a scenario file
// instead of GitCode, records what would have been posted on the merge
// request, and performs the merge by moving the branch in the fixture remote,
// so the script's own git work -- the CODEOWNERS lookup, the before/after
// range and the commit count -- runs for real.
const FAKE_HELPER = `import json, os, subprocess, sys

state = json.load(open(os.environ["FAKE_API_STATE"]))
command = sys.argv[1]
if command == "merge-command":
    asked = state.get("merge_command")
    if not asked:
        raise SystemExit("no /merge comment from an identifiable user on this merge request")
    print(asked["commenter"])
    print(asked["id"])
elif command == "pr-fields":
    for value in state["pr_fields"]:
        print(value)
elif command == "merge":
    if state.get("merge_error"):
        print(state["merge_error"])
        sys.exit(1)
    subprocess.check_call(
        ["git", "-C", state["remote"], "update-ref", "refs/heads/main", state["merge_to"]])
    print(json.dumps({"merged": True}))
elif command == "comment":
    with open(os.environ["FAKE_API_LOG"], "a", encoding="utf-8") as log:
        log.write("--- comment ---\\n" + open(sys.argv[3], encoding="utf-8").read())
else:
    raise SystemExit("unknown command " + command)
`;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.test",
  GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.test",
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository whose main branch carries CODEOWNERS and whose feature branch
// is two commits ahead: merging is moving main to it.
async function fixture(name) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${name}-`));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const work = join(directory, "work");
  git(directory, "init", "--bare", "--quiet", remote);
  git(directory, "-c", "init.defaultBranch=main", "init", "--quiet", seed);
  await writeFile(join(seed, "CODEOWNERS"), "# owners\n* @Alice @carol\n", "utf8");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "main");
  git(seed, "push", "--quiet", remote, "main");
  git(seed, "checkout", "--quiet", "-b", "feature");
  for (const step of ["one", "two"]) {
    await writeFile(join(seed, `${step}.txt`), step, "utf8");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", step);
  }
  git(seed, "push", "--quiet", remote, "feature");
  const head = git(seed, "rev-parse", "HEAD");

  git(directory, "-c", "init.defaultBranch=main", "init", "--quiet", work);
  git(work, "remote", "add", "origin", remote);
  await mkdir(join(work, ".ci"), { recursive: true });
  await copyFile(autoMergeScript, join(work, ".ci", "codearts-auto-merge.sh"));
  await writeFile(join(work, ".ci", "gitcode-merge-request.py"), FAKE_HELPER, "utf8");
  return { directory, remote, work, head };
}

async function run(name, { commenter = "alice", commentId = 7, commentedOn, pr = {}, mergeError } = {}) {
  const { directory, remote, work, head } = await fixture(name);
  const state = join(directory, "state.json");
  const log = join(directory, "comments.md");
  await writeFile(state, JSON.stringify({
    remote,
    merge_to: head,
    merge_command: commenter === null ? null : { commenter, id: commentId },
    merge_error: mergeError,
    pr_fields: [
      pr.state ?? "open",
      pr.base ?? "main",
      (pr.head ?? head).toLowerCase(),
      pr.mergeable ?? "true",
      pr.draft ?? "false",
      pr.merged ?? "false",
      pr.approvals ?? "true",
      pr.assignees ?? "",
    ],
  }), "utf8");

  const result = spawnSync("bash", [".ci/codearts-auto-merge.sh"], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env, ...GIT_IDENTITY,
      GITCODE_TOKEN: "test-token",
      CODEARTS_MERGE_ID: "74",
      CODEARTS_COMMIT_ID: commentedOn ?? head,
      FAKE_API_STATE: state, FAKE_API_LOG: log,
    },
  });
  const comments = await readFile(log, "utf8").catch(() => "");
  const merged = git(remote, "rev-parse", "refs/heads/main") === head;
  return { comments, directory, head, merged, result };
}

test("a CODEOWNER's /merge merges and reports the range it landed", async () => {
  const { comments, merged, result } = await run("owner");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(merged, "the target branch must have moved");
  assert.match(comments, /🔄 收到 @alice/);
  assert.match(comments, /✅ 自动合并完成/);
  assert.match(comments, /（2 个提交）/);
});

test("CODEOWNERS is matched without regard to case", async () => {
  const { result } = await run("case", { commenter: "ALICE" });
  assert.equal(result.status, 0, result.stderr);
});

test("a /merge from outside CODEOWNERS is refused and the branch stays put", async () => {
  const { comments, merged, result } = await run("outsider", { commenter: "mallory" });
  assert.equal(result.status, 1);
  assert.equal(merged, false);
  assert.match(comments, /@mallory 不在 `main` 分支的 CODEOWNERS 中/);
  assert.doesNotMatch(comments, /✅/);
});

test("a merge request that moved after the /merge comment is refused", async () => {
  const { comments, merged, result } = await run("moved", { commentedOn: "c".repeat(40) });
  assert.equal(result.status, 1);
  assert.equal(merged, false);
  assert.match(comments, /有新提交/);
});

test("draft, closed, merged and conflicting merge requests each say why", async () => {
  for (const [name, pr, expected] of [
    ["draft", { draft: "true" }, /仍是草稿/],
    ["closed", { state: "closed" }, /不是 open/],
    ["already", { merged: "true" }, /已经合并/],
    ["conflict", { mergeable: "false" }, /有冲突/],
  ]) {
    const { comments, merged, result } = await run(name, { pr });
    assert.equal(result.status, 1, `${name} must fail the job`);
    assert.equal(merged, false, `${name} must not merge`);
    assert.match(comments, expected);
  }
});

test("an unmet approval rule is forced through and the report says so", async () => {
  const { comments, merged, result } = await run("forced", {
    pr: { approvals: "false", assignees: "carol" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(merged);
  assert.match(comments, /审批规则尚未满足（审批人：carol）/);
});

test("a rejected merge call is quoted back on the merge request", async () => {
  const { comments, merged, result } = await run("rejected", {
    mergeError: "HTTP 405: Not enough required approvers",
  });
  assert.equal(result.status, 1);
  assert.equal(merged, false);
  assert.match(comments, /HTTP 405: Not enough required approvers/);
});

test("a merge request with no /merge comment at all stops before commenting", async () => {
  const { comments, merged, result } = await run("silent", { commenter: null });
  assert.equal(result.status, 1);
  assert.equal(merged, false);
  assert.equal(comments, "");
});

test("the pipeline sends exactly the values the merge script requires", async () => {
  const [pipeline, script] = await Promise.all([
    readFile(pipelineFile, "utf8"), readFile(autoMergeScript, "utf8")]);
  const envs = pipeline.match(/^ +ENVS: \|-\n((?: +\S+=.*\n)+)/m);
  assert.ok(envs, "the cloudBuild step must pass ENVS records");
  const sent = envs[1].trim().split("\n").map((record) => record.trim().split("=")[0]);
  assert.deepEqual(
    sent, ["CODEARTS_MERGE_ID", "CODEARTS_COMMIT_ID", "GITCODE_TOKEN"],
    "the private token must come last so no earlier record can shadow it");
  for (const name of sent) {
    assert.match(script, new RegExp(`\\b${name}\\b`), `${name} is sent but never read`);
  }
});

test.after(async () => {
  await rm(testRoot, { force: true, recursive: true });
});
