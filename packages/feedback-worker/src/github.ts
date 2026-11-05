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

import type { FeedbackSubmission } from "@sciencediscovery/operational-logging/feedback";

export interface CreateIssueRequest {
  token: string;
  owner: string;
  repo: string;
  receipt: string;
  submission: FeedbackSubmission;
}

export interface IssueResult {
  number: number;
  htmlUrl: string;
}

/** Title prefix carries the receipt so P2 status lookup can find the issue by code. */
export function issueTitle(receipt: string, title: string): string {
  return `[${receipt}] ${title}`;
}

export function issueLabels(submission: FeedbackSubmission): string[] {
  const labels = ["source:in-app", `kind:${submission.kind}`, "needs-triage"];
  if (submission.contact) labels.push(`contact:${submission.contact.type}`);
  return labels;
}

function field(value: string | undefined, fallback = "-"): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/** Markdown body stamped with a version marker so future tools can re-parse it. */
export function issueBody(receipt: string, submission: FeedbackSubmission): string {
  const meta = submission.meta ?? {};
  const installId = field(meta.installId).slice(0, 8);
  const contactLines = submission.contact
    ? `- type: ${submission.contact.type}\n- value: ${submission.contact.value}`
    : "- none";
  const diagnostics = submission.diagnostics ? `\`\`\`text\n${submission.diagnostics}\n\`\`\`` : "_(not attached)_";
  return [
    "<!-- sd-feedback:v1 -->",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    `| 回执码 | ${receipt} |`,
    `| 类型 | ${submission.kind} |`,
    `| 版本 | ${field(meta.version)} |`,
    `| 系统 | ${field(meta.os)} |`,
    `| 语言 | ${field(meta.locale)} |`,
    `| installId | ${installId} |`,
    "",
    "### 用户描述",
    "",
    submission.body,
    "",
    "### 诊断",
    "",
    diagnostics,
    "",
    "### 联系方式（私有，勿外传）",
    "",
    contactLines,
    "",
  ].join("\n");
}

export async function createIssue(
  fetchImpl: typeof fetch,
  request: CreateIssueRequest,
): Promise<IssueResult> {
  const url = `https://api.github.com/repos/${request.owner}/${request.repo}/issues`;
  const send = (labels: string[] | undefined) => fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${request.token}`,
      "Content-Type": "application/json",
      "User-Agent": "sciencediscovery-feedback",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: issueTitle(request.receipt, request.submission.title),
      body: issueBody(request.receipt, request.submission),
      ...(labels ? { labels } : {}),
    }),
  });

  let response = await send(issueLabels(request.submission));
  if (response.status === 422) {
    // A missing label fails the whole create with 422, and the deployment may
    // not have created every label. Retry unlabelled rather than lose the
    // report; triage can label it afterwards.
    response = await send(undefined);
  }
  if (!response.ok) throw new Error(`GitHub issue create failed: ${response.status}`);
  const data = (await response.json()) as { number: number; html_url: string };
  return { number: data.number, htmlUrl: data.html_url };
}