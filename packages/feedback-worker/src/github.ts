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

import type { FeedbackImage, FeedbackSubmission } from "@sciencediscovery/operational-logging/feedback";
import { sanitizeFeedbackImageName } from "@sciencediscovery/operational-logging/feedback";

/** URLs for the screenshots that made it into the repository, index-aligned
 *  with `submission.images` (an empty string marks a failed upload), plus the
 *  failure count so the issue can say so instead of silently dropping them. */
export interface FeedbackAttachments {
  urls: string[];
  failed: number;
}

export interface CreateIssueRequest {
  token: string;
  owner: string;
  repo: string;
  receipt: string;
  submission: FeedbackSubmission;
  attachments?: FeedbackAttachments;
}

export interface ImageUploadRequest {
  token: string;
  owner: string;
  repo: string;
  receipt: string;
  index: number;
  image: FeedbackImage;
}

export interface IssueResult {
  number: number;
  htmlUrl: string;
}

const GITHUB_API = "https://api.github.com";

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

function imageExtension(mime: FeedbackImage["mime"]): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "sciencediscovery-feedback",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Store one screenshot in the repository through the Contents API. The path is
 * derived from the receipt and the position, never from the user's filename, so
 * it cannot escape the folder or collide across reports. Returns the raw URL to
 * embed in the issue and the path needed to remove the file again.
 */
export async function uploadFeedbackImage(
  fetchImpl: typeof fetch,
  request: ImageUploadRequest,
): Promise<{ url: string; path: string }> {
  const { token, owner, repo, receipt, index, image } = request;
  const path = `feedback-images/${receipt}/${index + 1}.${imageExtension(image.mime)}`;
  const response = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify({
      message: `chore(feedback): attach screenshot for ${receipt}`,
      content: image.data,
    }),
  });
  if (!response.ok) throw new Error(`GitHub image upload failed: ${response.status}`);
  const data = (await response.json()) as { content?: { html_url?: string; download_url?: string } };
  const htmlUrl = data.content?.html_url;
  // `download_url` is only present on some responses; both point at the raw
  // bytes, which is what Markdown needs.
  const url = htmlUrl ? htmlUrl.replace("/blob/", "/raw/") : data.content?.download_url;
  if (!url) throw new Error("GitHub image upload returned no URL");
  return { url, path };
}

/** Remove one screenshot that was uploaded for an issue that never got created.
 *  Best effort: the caller only logs a failure here, because the report itself
 *  has already failed for a more important reason. */
export async function deleteFeedbackImage(
  fetchImpl: typeof fetch,
  request: { token: string; owner: string; repo: string; path: string },
): Promise<void> {
  const { token, owner, repo, path } = request;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const headers = githubHeaders(token);
  const lookup = await fetchImpl(url, { headers });
  if (!lookup.ok) throw new Error(`GitHub image lookup failed: ${lookup.status}`);
  const { sha } = (await lookup.json()) as { sha?: string };
  if (!sha) throw new Error("GitHub image lookup returned no sha");
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers,
    body: JSON.stringify({
      message: `chore(feedback): drop orphaned screenshot ${path}`,
      sha,
    }),
  });
  if (!response.ok) throw new Error(`GitHub image delete failed: ${response.status}`);
}

/** Markdown body stamped with a version marker so future tools can re-parse it. */
export function issueBody(
  receipt: string,
  submission: FeedbackSubmission,
  attachments: FeedbackAttachments = { urls: [], failed: 0 },
): string {
  const meta = submission.meta ?? {};
  const installId = field(meta.installId).slice(0, 8);
  const contactLines = submission.contact
    ? `- type: ${submission.contact.type}\n- value: ${submission.contact.value}`
    : "- none";
  const diagnostics = submission.diagnostics ? `\`\`\`text\n${submission.diagnostics}\n\`\`\`` : "_(not attached)_";
  const images = (submission.images ?? []).map((image, index) => {
    const url = attachments.urls[index];
    // An upload that failed leaves a gap in the array; say which image is
    // missing rather than rendering a broken link.
    return url
      ? `![${sanitizeFeedbackImageName(image.name)}](${url})`
      : `- ${sanitizeFeedbackImageName(image.name)}（上传失败，见 Worker 日志）`;
  });
  const imageFailureNote = attachments.failed > 0
    ? [`> ${attachments.failed} 张截图上传失败，已在下方标注。`, ""]
    : [];
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
    `| install Id | ${installId} |`,
    "",
    "### 用户描述",
    "",
    submission.body,
    "",
    "### 诊断",
    "",
    diagnostics,
    "",
    ...(images.length > 0 ? ["### 截图", "", ...imageFailureNote, ...images, ""] : []),
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
  const url = `${GITHUB_API}/repos/${request.owner}/${request.repo}/issues`;
  const send = (labels: string[] | undefined) => fetchImpl(url, {
    method: "POST",
    headers: githubHeaders(request.token),
    body: JSON.stringify({
      title: issueTitle(request.receipt, request.submission.title),
      body: issueBody(request.receipt, request.submission, request.attachments),
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
