# OBS usage in CodeArts CI

Read this reference when changing or diagnosing CodeArts OBS uploads, public
artifact links, code-check result JSON, ARM Build artifact transfer, or the
verified toolchain cache. The workflow source of truth is
`.codearts/workflow/codearts-pipeline.yml`; keep this reference synchronized
when its bucket, endpoint, prefixes, or required object set changes.

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
    |           |       |-- exit-code
    |           |       `-- <verified toolchain staging objects>
    |           `-- pr/
    |               `-- result.html
    |-- codecheck/<mr-id>/codecheck.json
    |-- blacklist/<mr-id>/blacklist.json
    |-- anti_poison/<mr-id>/anti_poison.json
    |-- sca/<mr-id>/sca.json
    `-- cache/
        `-- toolchains/
            `-- v1/
                `-- <immutable versioned toolchain object>
```

The parent pipeline owns the run-scoped `ci/` objects and consumes the four
code-check JSON objects. The registered code-check child tasks own those JSON
objects; do not make the parent overwrite them. The stable `cache/` prefix is
shared across runs and contains only checksum-pinned toolchain archives.

The code-check paths are MR-scoped rather than run-scoped and can be replaced
by a later child run for the same MR. Each JSON object supplies its own
`status` and optional HTTPS `link`. The parent snapshots all four results into
the current run's `pr/result.html`; downstream publishers must consume that
run-scoped HTML instead of rereading possibly newer JSON.

The aarch64 run directory temporarily carries the verified Node, CPython,
micromamba, pnpm, and uv objects because the graphical ARM Build upload action
can publish only its configured artifact directory. The dependent verifier
downloads and verifies those objects, then copies them to the stable cache
prefix with `upload-obs`. They are staging copies, not additional cache keys.

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
handles cache staging objects. Missing or malformed objects fail closed.

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

When a pinned version or filename changes, update the workflow keys, fetcher
manifest, expected SHA256, staging name, and this inventory together.

Fetchers use this order:

1. Reuse a local object only if its pinned SHA256 matches.
2. Try the public OBS cache and accept it only if the same checksum matches.
3. On a missing or invalid cache object, fetch the configured mirror or
   authoritative source and verify it.
4. Refill OBS only from a successful job and only with the verified bytes.

Upload run-scoped binaries, `SHA256SUMS`, and `VERSION` before refilling the
shared cache. A cache upload failure may keep the job red, but it must not
prevent the primary build artifacts from being published for diagnosis.

Public runtime code exposes only the generic `BINARY_CACHE_URL` and
`BINARY_CACHE_DIR` interface. Translate CodeArts variables in `.ci/` or
`.codearts/`; do not introduce OBS-specific behavior into public runtime
scripts. Do not cache lockfile-driven dependency trees, mutable catalogs, or
distro-specific package-manager downloads in this prefix.

## Failure signals

| Symptom | Interpretation and action |
| --- | --- |
| `source_file` must start below the current share path | Use an absolute `${SHARE_PATH}/...` source. |
| A run-scoped public URL returns `403` after an early failure | The upload probably never ran. Use the CodeArts/GitCode job log and do not present the URL as an artifact. |
| ARM Build is green but a required aarch64 object is absent | Compare `OBS_DIRECTORY`, `ARTIFACT_PATH`, the package output directory, and the verifier's required names. Keep verification red. |
| CPython exists in the Build log but its public URL returns `403` | Percent-encode `+` as `%2B` in the HTTP request. Do not rename the OBS key. |
| A stable cache object has the wrong checksum | Treat it as a cache miss, download the pinned source, and refill only after successful verification. Never change the expected checksum to accept cached bytes. |
| A rerun shows artifacts from an earlier run | The object key omitted `pipeline.run_id`. Restore the `<commit>/<run-id>/` hierarchy. |
