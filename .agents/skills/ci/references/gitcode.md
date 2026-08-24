# GitCode Actions

Read this reference for `.gitcode/workflows/`, GitCode Actions validation,
GitCode-hosted runner behavior, or GitCode Actions status and logs.

## Hosted runner constraints

The hosted runner is an Ubuntu 24.04 Docker container running as uid 20001. It
ships `git`, `curl`, `wget`, `sudo`, `apt-get`, `python3`, `tar`, and `xz`, but
not Node, npm, corepack, or bubblewrap. `.ci/provision-runner.sh` installs the
missing user-space tools.

Its capability bounding set omits `CAP_SYS_ADMIN` and seccomp blocks namespace
creation. Installing bubblewrap, changing runner size, using a custom
`container:`, becoming root inside the job, or requesting `--privileged` cannot
restore a capability absent from the bounding set. There is also no schedulable
arm64 hosted runner.

Consequently `.gitcode/workflows/ci.yml` runs `ci:ut:core` and hermetic `ci:st`,
omits E2E, and builds only x86_64 with `--skip-smoke`. GitHub covers Runner UT,
mocked E2E, and native smoke-gated binaries on both architectures.

## Workflow syntax and branch validation

Every step needs a `name`; a bare `- uses:` is rejected. Checkout is
`uses: checkout`, lands directly in the working directory, and does not use a
version suffix. `run:` executes with `bash -e`. Re-export the user-installed
Node/pnpm/uv paths in every later step because PATH changes do not cross step
boundaries.

GitCode registers workflows only from the default branch, so a new workflow
file that exists only on a feature branch is invisible in the workflow list.
Once the workflow exists on the default branch, dispatch can validate the
feature-branch version:

```bash
TOKEN=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.config/gc/auth.json')));print(d['hosts']['gitcode.com']['users'][d['hosts']['gitcode.com']['active_user']]['token'])")
B=https://api.gitcode.com/api/v8/repos/<owner>/<repo>/actions

curl -sS -H "Authorization: Bearer $TOKEN" "$B/workflows"
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"ref":"<branch>"}' \
  "$B/workflows/<workflow-id>/dispatches"
```

A `201` with `workflow_run_id` means the branch YAML validated. A `400` names
the first invalid key or missing plugin. Fix it and dispatch again; the
validator may reveal only one error per request.

## Read a result

Use `api.gitcode.com`, not `gitcode.com`, for the v8 API. In the current
service, only the workflow listing above is reliable:

- `/actions/runs` returns `PARAMETER_ERROR … codeArtsIds` after a workflow is
  registered, even when actor filters are supplied.
- Documented run-detail, jobs, and `download_log` routes return `NOT_PATH`.
- The run listing was incomplete even before the current actor error.

Therefore do not claim a missing API record means no run occurred. Read the
GitCode Actions web UI, or ask the user for the complete job log. If the public
API behavior changes, verify a route with a known UI-visible run before adding
it back to this skill.

## Do not confuse GitCode Actions with CodeArts

The merge-request bot table returned by

```bash
gitcode pr view <number> -R <owner>/<repo> --comments --json
```

belongs to an external CodeArts pipeline. CodeArts PaC runs do not register in
GitCode's `/api/v8/.../actions` endpoints. Their console links and run IDs may
appear on the MR check page, but reading the run detail requires CodeArts
credentials or a user-provided log.

## Failure signals

| Symptom | Meaning |
| --- | --- |
| Job fails in about one second, `start_time` is null, and the log is empty or only `FAILED` | The job was not scheduled or expanded; an unsupported arm64 label is a known cause. |
| `bwrap: No permissions to create new namespace` | The hosted container cannot run a sandbox; use `ci:ut:core`, not a stand-in for Runner tests. |
| Workflow list is empty while the file exists only on a branch | Registration reads the default branch. |
| `/actions/runs` reports `codeArtsIds` | Current GitCode service failure, not a missing query parameter discovered so far. |
