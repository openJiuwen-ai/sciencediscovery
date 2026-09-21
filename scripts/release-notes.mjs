#!/usr/bin/env node
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

// Composes the body of a GitHub release.
//
// GitHub's generate-notes API already produces the sections a reader of any
// open source project expects — What's Changed, New Contributors, and the
// compare link — so this keeps that output verbatim instead of reimplementing
// it, and adds the one thing it does not carry: how much is in the release.
//
// What the release means still has to be written by a person. That belongs at
// the top, and the placeholder below says so; nothing here tries to infer
// highlights from commit subjects. The numbers are the part a script can do
// honestly, and each one comes from an endpoint anybody can query again:
//
//   commits       compare(previous...tag).total_commits
//   contributors  the distinct commit authors in that same comparison
//   pull requests the pull requests generate-notes itself listed
//   issues        closingIssuesReferences of those pull requests — the issues
//                 this release actually closes, not the ones that happened to
//                 be closed while it was being written
//
// Usage:
//   node scripts/release-notes.mjs --repo <owner/name> --tag <tag> \
//     [--previous <tag>] [--output <file>]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const gh = (arguments_) =>
  execFileSync("gh", arguments_, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const ghJson = (arguments_) => JSON.parse(gh(arguments_));

// --- Pure helpers, so the parsing this depends on can be tested without a
// --- network or a repository.

// generate-notes writes one bullet per pull request, each ending in the pull
// request's URL. Counting the links rather than the bullets keeps the figure
// equal to what the reader can see listed right below it.
export const pullRequestNumbers = (body) => {
  const numbers = new Set();
  for (const match of body.matchAll(/\/pull\/(\d+)\b/g)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
};

// The section exists only when somebody's first contribution landed in the
// range, so its absence means zero rather than a parsing failure.
export const newContributorCount = (body) => {
  const section = body.split(/^##+ +New Contributors\s*$/m)[1];
  if (section === undefined) return 0;
  const untilNextHeading = section.split(/^##+ /m)[0];
  return untilNextHeading.split("\n").filter((line) => /^\* /.test(line)).length;
};

// Used only when there is no earlier tag to compare against: the authors
// generate-notes credited are then the best available answer, and saying so is
// better than reporting nothing.
// An app is credited as `@name[bot]`, and on this mirror the sync and release
// bots author most of what lands, so a pattern that expects a bare handle to
// be followed by ` in ` drops the majority of the authors it is counting.
export const contributorHandlesFrom = (body) => {
  const handles = new Set();
  for (const match of body.matchAll(/^\* .* by @([A-Za-z0-9-]+)(?:\[bot\])? in /gm)) handles.add(match[1]);
  return [...handles].sort();
};

// The most recent release published before this tag. Releases come back newest
// first, but a draft has not been announced to anybody and a release created
// out of order would otherwise silently become the baseline.
export const previousTagFrom = (releases, tag) => {
  const candidates = releases
    .filter((release) => release.tagName !== tag && !release.isDraft)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return candidates[0]?.tagName;
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const formatSummary = ({ commits, contributors, issues, newContributors, pullRequests }) => {
  const parts = [];
  if (commits !== undefined) parts.push(`**${plural(commits, "commit")}**`);
  // Commits and contributors are true of every release. Pull requests and
  // issues are not: this repository is a mirror, and the range 0.1.1...0.2.0
  // predates its pull request workflow entirely — those commits were pushed
  // straight to the branch, so the honest count is zero. Printing
  // "0 pull requests · 0 issues closed" reads like a broken generator rather
  // than like history, so a zero is left out instead of dressed up.
  if (pullRequests) parts.push(`**${plural(pullRequests, "pull request")}**`);
  if (issues) parts.push(`**${plural(issues, "issue")} closed**`);
  if (contributors !== undefined) {
    const suffix = newContributors > 0 ? ` (${newContributors} new)` : "";
    parts.push(`**${plural(contributors, "contributor")}**${suffix}`);
  }
  return parts.join(" · ");
};

export const composeBody = ({ generated, summary }) =>
  [
    summary,
    "",
    "<!-- Highlights: what this release means, in a few lines, above the generated",
    "     sections below. A release nobody can read the point of is a tag with",
    "     binaries attached. Edit this release to add them, then delete this note. -->",
    "",
    generated.trim(),
    "",
  ].join("\n");

// --- The queries.

const compareStatistics = (repository, base, head) => {
  const total = ghJson([
    "api",
    `repos/${repository}/compare/${base}...${head}`,
    "--jq",
    "{commits: .total_commits}",
  ]);
  // The comparison caps each page at 100 commits, and a release spanning
  // several hundred is normal here — 0.1.1...0.2.0 was 349 — so the author
  // list has to be paged or the contributor count silently truncates.
  const authors = gh([
    "api",
    "--paginate",
    `repos/${repository}/compare/${base}...${head}?per_page=100`,
    "--jq",
    ".commits[] | .author.login // .commit.author.name",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { commits: total.commits, contributors: new Set(authors).size };
};

// closingIssuesReferences is the link GitHub itself draws between a merged
// pull request and the issues it closed, so this counts the issues the release
// resolves rather than every issue closed in the same window. Batched because
// a release can carry a hundred pull requests and each is one field selection.
const closedIssueCount = (repository, pullRequests) => {
  const [owner, name] = repository.split("/");
  const closed = new Set();
  for (let index = 0; index < pullRequests.length; index += 50) {
    const batch = pullRequests.slice(index, index + 50);
    const selections = batch
      .map(
        (number) =>
          `pr${number}: pullRequest(number: ${number}) { closingIssuesReferences(first: 50) { nodes { number } } }`,
      )
      .join("\n");
    const query = `query { repository(owner: "${owner}", name: "${name}") { ${selections} } }`;
    const response = ghJson(["api", "graphql", "-f", `query=${query}`]);
    for (const field of Object.values(response.data.repository ?? {})) {
      for (const issue of field?.closingIssuesReferences?.nodes ?? []) closed.add(issue.number);
    }
  }
  return closed.size;
};

const main = () => {
  const options = new Map();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    options.set(argv[index].replace(/^--/, ""), argv[index + 1]);
  }
  const repository = options.get("repo");
  const tag = options.get("tag");
  if (!repository || !tag) {
    console.error("Usage: release-notes.mjs --repo <owner/name> --tag <tag> [--previous <tag>] [--output <file>]");
    process.exit(2);
  }

  const previous =
    options.get("previous") ??
    previousTagFrom(
      ghJson(["release", "list", "--repo", repository, "--limit", "100", "--json", "tagName,isDraft,publishedAt"]),
      tag,
    );

  // Without a baseline GitHub reports the whole history, which is correct for
  // a first release and useless as a delta, so the figures that only mean
  // something against a previous tag are left out rather than invented.
  // --target names the commit a tag that does not exist yet would point at, so
  // the notes for a release can be read before the tag is pushed. Publishing
  // passes a tag that already exists and leaves it unset.
  const target = options.get("target");
  const notesArguments = ["api", `repos/${repository}/releases/generate-notes`, "-f", `tag_name=${tag}`];
  if (target) notesArguments.push("-f", `target_commitish=${target}`);
  if (previous) notesArguments.push("-f", `previous_tag_name=${previous}`);
  // `--jq .body` prints the string itself rather than a JSON document, so this
  // one reads raw where every other call here parses.
  const generated = gh([...notesArguments, "--jq", ".body"]);

  const pullRequests = pullRequestNumbers(generated);
  const statistics = {
    issues: pullRequests.length > 0 ? closedIssueCount(repository, pullRequests) : 0,
    newContributors: newContributorCount(generated),
    pullRequests: pullRequests.length,
  };
  if (previous) {
    Object.assign(statistics, compareStatistics(repository, previous, target ?? tag));
  } else {
    statistics.contributors = contributorHandlesFrom(generated).length;
  }

  const body = composeBody({ generated, summary: formatSummary(statistics) });
  const output = options.get("output");
  if (output) writeFileSync(output, body);
  else process.stdout.write(body);
  console.error(
    `release notes for ${tag}${previous ? ` since ${previous}` : " (no previous release)"}: ${formatSummary(statistics)}`,
  );
};

if (import.meta.url === `file://${process.argv[1]}`) main();
