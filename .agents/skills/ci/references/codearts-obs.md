# OBS usage in CodeArts CI

Read this reference when changing or diagnosing CodeArts OBS uploads, public
artifact links, code-check result JSON, ARM Build artifact transfer, or the
verified toolchain cache. The workflow source of truth is
`.codearts/workflow/codearts-pipeline.yml` on the formal CI branch plus
`.codearts/workflow/codearts-resources-pipeline.yml` on
`ci/codearts-resources`; keep this reference synchronized when either
workflow's bucket, endpoint, prefixes, or required object set changes.

## Address forms

The debug pipeline uses one bucket and endpoint:

| Field | Value |
| --- | --- |
| Bucket | `openjiuwen-ci` |
| OBS endpoint | `obs.cn-north-4.myhuaweicloud.com` |
| Public base URL | `https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/` |
| OBS URI prefix | `obs://openjiuwen-ci/` |

An OBS plugin `key` is the object path below the bucket. It has no leading
slash. For example, these two addresses identify the same object:

```text
obs://openjiuwen-ci/sciencediscovery/ci/<commit>/<run-id>/st/run.log
https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/ci/<commit>/<run-id>/st/run.log
```

Keep credentials and endpoint selectors in CodeArts. Do not commit access
keys, secret keys, signed URLs, or console-only identifiers that the workflow
does not already require.

## Object-key layout

`<commit>` is the full 40-character source commit and `<short-commit>` is its
first eight characters. `<run-id>` is `pipeline.run_id`, so reruns of the same
commit do not overwrite one another. `<mr-id>` is the GitCode merge-request
number.

```text
openjiuwen-ci/
`-- sciencediscovery/
    |-- ci/
    |   `-- <commit>/
    |       `-- <run-id>/
    |           |-- ut/
    |           |   `-- run.log
    |           |-- ut-runner-qemu/
    |           |   `-- run.log
    |           |-- st/
    |           |   `-- run.log
    |           |-- binary/
    |           |   |-- x86_64/
    |           |   |   |-- ScienceDiscovery-<short-commit>-linux-x86_64
    |           |   |   |-- SHA256SUMS
    |           |   |   |-- VERSION
    |           |   |   `-- run.log
    |           |   `-- aarch64/
    |           |       |-- ScienceDiscovery-<short-commit>-linux-aarch64
    |           |       |-- SHA256SUMS
    |           |       |-- VERSION
    |           |       |-- run.log
    |           |       `-- exit-code
    |           `-- pr/
    |               `-- result.html
    |-- codecheck/<mr-id>/codecheck.json
    |-- blacklist/<mr-id>/blacklist.json
    |-- anti_poison/<mr-id>/anti_poison.json
    |-- sca/<mr-id>/sca.json
    `-- cache/
        |-- toolchains/
        |   `-- v1/
        |       `-- <immutable versioned toolchain object>
        |-- qemu/
        |   `-- v1/
        |       `-- noble-server-cloudimg-amd64.img
        `-- qemu-runner/
            `-- v1/
                `-- <resource-commit>/
                    `-- <resource-run-id>/
                        |-- ScienceDiscovery-qemu-runner-noble-amd64.qcow2
                        |-- SHA256SUMS
                        `-- VERSION
```

The parent pipeline owns the run-scoped `ci/` objects and consumes the four
code-check JSON objects. The registered code-check child tasks own those JSON
objects; do not make the parent overwrite them. The stable `cache/` prefix is
shared across runs and contains only checksum-pinned immutable artifacts:
versioned toolchain archives and the date-pinned QEMU Ubuntu base image.

The code-check paths are MR-scoped rather than run-scoped and can be replaced
by a later child run for the same MR. Each JSON object supplies its own
`status` and optional HTTPS `link`. The parent snapshots all four results into
the current run's `pr/result.html`; downstream publishers must consume that
run-scoped HTML instead of rereading possibly newer JSON.

Stable resources are not staged below a run-scoped aarch64 directory. The
dedicated `ci/codearts-resources` workflow writes them directly to their
stable keys after checksum verification; the formal x86_64 and aarch64 jobs
are read-only cache consumers.

## Upload contracts

For a pipeline `upload-obs` step:

- `source_file` must be an absolute path below `${SHARE_PATH}`. The plugin
  rejects repository-relative paths before contacting OBS.
- Set `self_folder: "false"` when `key` names the exact destination object.
- Include both `<commit>` and `<run-id>` in run-scoped keys.
- Stage `run.log` and the real command exit code before upload. Upload
  diagnostics, then restore the command exit code; an upload must never turn a
  failed test or package build green.
- Do not treat `artifactIdentifier` as evidence that an OBS object exists.

Example:

```yaml
- name: Upload ST log to OBS
  uses: upload-obs
  with:
    endpoint: obs.cn-north-4.myhuaweicloud.com
    bucket: openjiuwen-ci
    key: "sciencediscovery/ci/${{ sources.sciencediscovery.commit_id }}/${{ pipeline.run_id }}/st/run.log"
    source_file: "${SHARE_PATH}/.ci-results/st/run.log"
    self_folder: "false"
```

The ARM Build task uses a different upload shape. Its console action uploads
every file under `.codearts-build/repository/${ARTIFACT_PATH}/` to
`${OBS_DIRECTORY}`. The parent therefore passes this exact run prefix:

```text
OBS_DIRECTORY=sciencediscovery/ci/<commit>/<run-id>/binary/aarch64/
```

Keep the trailing slash, `ARTIFACT_PATH`, the package script output directory,
and the parent verifier's base URL aligned.

## Public reads and verification

Map a key to the public URL by appending it to the public base URL. Encode each
path segment for HTTP without changing the stored OBS key. In particular, a
literal `+` in the CPython object name must be requested as `%2B`; an unescaped
URL can return `403` even when the object exists.

For a cheap existence probe, request `Range: bytes=0-0` and accept only HTTP
`200` or `206`. A missing public object may also return `403`, so do not infer
an authorization problem from that status alone. An early checkout or
provisioning failure occurs before upload and legitimately leaves no public
`run.log`; link to the GitCode Checks page instead of publishing a dead URL.

Existence is not integrity. After downloading a binary or toolchain object,
verify its pinned SHA256 before using or republishing it. The aarch64 verifier
requires the binary, `SHA256SUMS`, `VERSION`, `run.log`, and `exit-code`, checks
that `exit-code` is exactly zero, and validates the checksum record before it
reports the aarch64 build result. Missing or malformed objects fail closed.

The four code-check JSON files are independent inputs. Read and normalize each
one separately as documented in [codearts.md](codearts.md); a valid result from
one path must not stand in for a missing or malformed sibling.

## Stable toolchain cache

The public cache base is:

```text
https://openjiuwen-ci.obs.cn-north-4.myhuaweicloud.com/sciencediscovery/cache/toolchains/v1/
```

It holds the pinned Node, CPython, micromamba, pnpm, and uv archives for both
CPU architectures where applicable. The cache key is the upstream/versioned
filename; never replace one key with different bytes. The current inventory is:

```text
sciencediscovery/cache/toolchains/v1/
|-- node-v22.19.0-linux-x64.tar.xz
|-- node-v22.19.0-linux-arm64.tar.xz
|-- cpython-3.12.13+20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
|-- cpython-3.12.13+20260805-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz
|-- micromamba-2.8.1-0-linux-64.tar.bz2
|-- micromamba-2.8.1-0-linux-aarch64.tar.bz2
|-- pnpm-11.1.2.tgz
|-- uv-0.9.26-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
`-- uv-0.9.26-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
```

When a pinned version or filename changes, update the resource branch's
manifest, expected SHA256, upload key, formal consumer configuration, and this
inventory together.

The dedicated `ci/codearts-resources` workflow uses this order:

1. Reuse a local object only if its pinned SHA256 matches.
2. Try the public OBS cache and accept it only if the same checksum matches.
3. On a missing or invalid cache object, fetch the configured mirror or
   authoritative source and verify it.
4. Upload only the verified bytes to the stable key.

The formal CodeArts workflow sets `CI_BINARY_CACHE_ONLY=1` or
`BINARY_CACHE_ONLY=1` for UT, ST, QEMU guest provisioning, and both binary
architectures. These consumers use local verified bytes or public OBS only;
on a miss or checksum mismatch they fail without contacting a source mirror
and without uploading to the stable prefix. Seed the resource branch first,
then rerun the formal workflow.

Public runtime code exposes only the generic `BINARY_CACHE_URL` and
`BINARY_CACHE_DIR` interface. Translate CodeArts variables in `.ci/` or
`.codearts/`; do not introduce OBS-specific behavior into public runtime
scripts. Do not cache lockfile-driven dependency trees, mutable catalogs, or
distro-specific package-manager downloads in this prefix.

## Stable QEMU image cache

The QEMU image has a separate cache namespace because it is much larger than
the toolchain objects:

```text
sciencediscovery/cache/qemu/v1/noble-server-cloudimg-amd64.img
```

Its expected SHA256 is
`d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30`.
The resource branch's 40-minute `resource_qemu` job calls
`.ci/prepare-codearts-resources.sh --group qemu`, which delegates through
`.ci/fetch-qemu-image.sh` to `.ci/fetch-verified-binary.sh`. It checks local
bytes, public OBS, then the pinned TUNA source with the same digest and a
1,800-second per-download limit. Its `upload-obs` step writes only the verified
image to the stable key. A push to `ci/codearts-resources` triggers this
workflow; the branch is operational infrastructure and is not merged into
`main`.

The QEMU base is consumed only by the resource workflow. Formal Runner UT uses
the pre-provisioned image described below, so it does not repeat cloud-image
package and toolchain provisioning.

## Pre-provisioned QEMU Runner image

The resource workflow boots the verified Ubuntu base once, installs and tests
Node, pnpm, uv, bubblewrap, and the stable system packages, compacts the qcow2,
then uploads and reads back three objects. The current immutable set is:

```text
sciencediscovery/cache/qemu-runner/v1/
`-- 7365ff8e9bfb6aa2414c1dc09bf79b3f3e6bc4c8/
    `-- f8d5a313663c418a8c54eec630ebe881/
        |-- ScienceDiscovery-qemu-runner-noble-amd64.qcow2
        |   SHA256: `.ci/qemu-runner-image.sha256`
        |-- SHA256SUMS
        `-- VERSION
```

For a push-triggered resource workflow, derive the resource commit from the
checked-out repository with `git rev-parse HEAD`, validate it as a 40-character
hex SHA, and publish it as a job output. Downstream jobs must consume that
output and verify their own checkout has the same commit before constructing
OBS keys. Do not use `sources.sciencediscovery.commit_id` for this purpose: it
can be empty for a branch-push trigger and would produce a path with a missing
commit component.

`.ci/fetch-qemu-runner-image.sh` pins the resource commit and resource run;
`.ci/qemu-runner-image.sha256` is the single source of truth for the image name
and digest. Together they form one release unit. The formal 20-minute Runner
job accepts only that exact object and has no source fallback. It creates a
disposable overlay, injects the current repository archive, verifies the baked
toolchain and sandbox, and immediately invokes `pnpm ci:ut:guest`; boot no
longer runs apt or `.ci/provision-runner.sh`.

Advancing the image is deliberate: push or rerun `ci/codearts-resources`, wait
for `Verified published QEMU Runner image: <sha256>`, then update the resource
commit and run in `.ci/fetch-qemu-runner-image.sh` together with the standard
checksum record in `.ci/qemu-runner-image.sha256`. Never reuse a resource path
with different bytes and never update only the expected checksum to accept an
unverified object.

## Failure signals

| Symptom | Interpretation and action |
| --- | --- |
| `source_file` must start below the current share path | Use an absolute `${SHARE_PATH}/...` source. |
| A run-scoped public URL returns `403` after an early failure | The upload probably never ran. Use the CodeArts/GitCode job log and do not present the URL as an artifact. |
| ARM Build is green but a required aarch64 object is absent | Compare `OBS_DIRECTORY`, `ARTIFACT_PATH`, the package output directory, and the verifier's required names. Keep verification red. |
| CPython exists in the Build log but its public URL returns `403` | Percent-encode `+` as `%2B` in the HTTP request. Do not rename the OBS key. |
| A formal job reports a stable cache miss or checksum mismatch | Keep it failed. Run the `ci/codearts-resources` workflow, verify its checksum-pinned upload, update the prebuilt-image pins when advancing that image, then rerun the formal job. Do not add source fallback to formal CI. |
| The resource QEMU job falls back to TUNA on every run | The stable image object is absent, the prior upload failed, or its checksum is wrong. Read `resource_qemu`, then verify the exact `cache/qemu/v1` key before rerunning formal CI. |
| A rerun shows artifacts from an earlier run | The object key omitted `pipeline.run_id`. Restore the `<commit>/<run-id>/` hierarchy. |
