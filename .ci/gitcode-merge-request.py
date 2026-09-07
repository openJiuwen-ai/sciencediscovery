#!/usr/bin/env python3
# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The GitCode calls .ci/codearts-auto-merge.sh makes, and the parsing of what
they return.

Reading and deciding are deliberately separate. The commands that talk to the
REST API hand what they receive to a `parse_*` function, and every `parse-*`
subcommand runs that same function over a JSON document on standard input, so
.ci/auto-merge.test.mjs exercises the decisions that authorize or reject a
merge without a network.

The token only ever travels in the request URL and is never printed. An HTTP
error prints `HTTP <code>: <detail>` on stdout and exits 1, so the caller can
quote the reason on the merge request.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def call(method, path, data=None):
    base = os.environ["GITCODE_API_BASE"].rstrip("/")
    owner, repo = os.environ["REPO_OWNER"], os.environ["REPO_NAME"]
    separator = "&" if "?" in path else "?"
    url = "{}/repos/{}/{}/{}{}access_token={}".format(
        base, owner, repo, path, separator,
        urllib.parse.quote(os.environ["GITCODE_TOKEN"], safe=""))
    request = urllib.request.Request(
        url,
        data=None if data is None else json.dumps(data).encode("utf-8"),
        method=method,
        headers={"Content-Type": "application/json", "User-Agent": "ScienceDiscovery-CodeArts"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500].replace("\n", " ")
        print("HTTP {}: {}".format(error.code, detail or error.reason))
        sys.exit(1)


def parse_pull_request(document):
    """The merge request's live state, one field per line."""
    pull_request = json.loads(document)
    mergeable = pull_request.get("mergeable")
    checks = pull_request.get("mergeable_state")
    checks = checks if isinstance(checks, dict) else {}
    approval_keys = ("approval_reviewers_required_passed",
                     "approval_approvers_required_passed",
                     "approval_testers_required_passed")
    known = [checks.get(key) for key in approval_keys if key in checks]
    approvals = "unknown" if not known else ("true" if all(known) else "false")
    assignees = ",".join(sorted(
        (entry.get("login") if isinstance(entry, dict) else str(entry)) or ""
        for entry in (pull_request.get("assignees") or [])
        + (pull_request.get("approval_reviewers") or [])))
    return [
        pull_request.get("state") or "",
        (pull_request.get("base") or {}).get("ref") or "",
        ((pull_request.get("head") or {}).get("sha") or "").lower(),
        "null" if mergeable is None else str(bool(mergeable)).lower(),
        "true" if pull_request.get("draft") else "false",
        "true" if pull_request.get("merged") else "false",
        approvals,
        assignees,
    ]


def parse_merge_command(document):
    """Who asked for the merge.

    The build task is not handed the webhook payload -- a note payload is
    several kilobytes of JSON and would have to survive a build parameter
    intact -- so the commenter comes back from the merge request itself. The
    newest `/merge` comment wins, which is the one that triggered this run
    unless a newer one arrived in between; that one is equally a request to
    merge, and either way the comment still has to pass CODEOWNERS.
    """
    comments = json.loads(document)
    if not isinstance(comments, list):
        raise SystemExit("the comments endpoint did not return a list")
    newest = None
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        body = (comment.get("body") or "").strip()
        if (body.split() or [""])[0] != "/merge":
            continue
        user = comment.get("user") or {}
        commenter = user.get("login") or user.get("username") or user.get("name") or ""
        if not commenter or "\n" in commenter or "\r" in commenter:
            continue
        order = (str(comment.get("created_at") or ""), int(comment.get("id") or 0))
        if newest is None or order > newest[0]:
            newest = (order, commenter, comment.get("id"))
    if newest is None:
        raise SystemExit("no /merge comment from an identifiable user on this merge request")
    return [newest[1], str(newest[2])]


def collect_comments(number):
    """Every comment on the merge request, oldest page first."""
    comments = []
    for page in range(1, 11):
        batch = json.loads(call(
            "GET", "pulls/{}/comments?per_page=100&page={}".format(number, page)))
        if not isinstance(batch, list) or not batch:
            break
        comments.extend(batch)
        if len(batch) < 100:
            break
    return json.dumps(comments)


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "pr-fields":
        for value in parse_pull_request(call("GET", "pulls/{}".format(argv[2]))):
            print(str(value).replace("\n", " "))
    elif command == "merge-command":
        for value in parse_merge_command(collect_comments(argv[2])):
            print(value)
    elif command == "merge":
        # GitCode replays the merge request's commits onto the target: linear
        # history, no merge commit. force_merge needs the repository's
        # "allow administrators to force merge" setting and an admin token.
        print(call("PUT", "pulls/{}/merge".format(argv[2]),
                   {"merge_method": "rebase", "force_merge": True}))
    elif command == "comment":
        with open(argv[3], encoding="utf-8") as body_file:
            call("POST", "pulls/{}/comments".format(argv[2]), {"body": body_file.read()})
    elif command == "parse-pr":
        for value in parse_pull_request(sys.stdin.read()):
            print(str(value).replace("\n", " "))
    elif command == "parse-merge-command":
        for value in parse_merge_command(sys.stdin.read()):
            print(value)
    else:
        raise SystemExit("unknown command {}".format(command or "<missing>"))


if __name__ == "__main__":
    main(sys.argv)
