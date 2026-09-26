# Single-file Binary Packaging and Releases

This document describes the Linux single-file release build, build identifiers, package contents, and first-launch bootstrap. User installation steps live in the [deployment guide](../getting-started/deployment.md).

## Build identifiers

Runner and release builds use the first 8 characters of the Git commit as the build identifier rather than an internal milestone name.

- `pnpm build` writes the build information automatically;
- SEA packaging preserves the same identifier;
- the runtime host does not need Git;
- tracked uncommitted changes append `-dirty`;
- official releases should be built from a clean checkout.

For source archives without Git metadata, set:

```bash
SCIENCE_AGENT_BUILD_COMMIT=<full commit SHA>
```

When neither Git metadata nor an explicit SHA is available, the identifier is `unknown`; no fake version is invented.

A local/remote build mismatch is informational and does not by itself block connection. Existing deployed Runners continue reporting their old identifier until replaced.

## Build a release artifact

From the repository root:

```bash
case "$(uname -m)" in
  x86_64|amd64|x64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

./scripts/package-binary-release.sh \
  --arch "$arch" \
  --version local \
  --output dist/binary-release-local

artifact="dist/binary-release-local/ScienceDiscovery-local-linux-$arch"
(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
"$artifact" serve
```

The output contains:

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
VERSION
SHA256SUMS
```

### Build both architectures

```bash
./scripts/package-binary-release.sh \
  --version local \
  --output dist/binary-release-local

(cd dist/binary-release-local && sha256sum --check SHA256SUMS)
```

To build one architecture only:

```bash
./scripts/package-binary-release.sh \
  --arch x86_64 \
  --version local \
  --output dist/binary-release-local
```

The build host needs Node, pnpm, uv, tar, zstd, and sha256sum. It needs neither Docker nor QEMU.

Node and CPython runtimes are downloaded with versions and SHA256 values pinned in `scripts/binary-release/runtimes.json`. TypeScript outputs, web assets, and the gateway wheel are architecture-independent; the packager separately checks the ELF architecture of bundled CPython extension modules.

Compression defaults to zstd level 19. `SCIENCE_AGENT_PAYLOAD_ZSTD_LEVEL` can lower it during iteration.

## What is inside the single file

| Component | Description |
| --- | --- |
| Launcher | Node single-executable application; the final artifact is a normal ELF executable |
| Node runtime | Used by the control API and Runner |
| CPython 3.12 | Relocatable Python and the base interpreter for the first-launch gateway venv |
| Web assets | Prebuilt `apps/web/dist` |
| Gateway wheel and bootstrap manifest | Product gateway wheel, hash-pinned dependency export, and uv wheel pin |
| JiuwenSwarm and adapter | Pinned JiuwenSwarm plus the product adapter and their build-time dependency trees |
| micromamba | Pinned version seeded to the data directory on first launch and verified by Runner |

The release intentionally does **not** bundle:

- the uv runtime environment itself;
- the gateway's complete third-party Python dependency tree;
- Neo4j;
- starter Python/R scientific environments;
- a conda package cache.

This keeps the artifact smaller while preserving verifiable runtime pins.

## First-launch bootstrap

The first single-file `serve` extracts the embedded payload to:

```text
~/.cache/science-discovery/payload/<payload-id>
```

Override with `XDG_CACHE_HOME` or `SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR`.

The payload digest is part of the directory name, so upgrades do not overwrite older extractions. The historical `~/.cache/science-agent` path is imported once only when the new destination is absent.

Two dependency layers are then prepared:

1. **uv** — download the build-pinned uv wheel from the configured PyPI index, verify its SHA256, and place the executable under `<data-dir>/tools/uv/`;
2. **gateway Python environment** — create `<data-dir>/envs/gateway` on the bundled CPython and install the hash-pinned requirements exported from `services/gateway/uv.lock`.

Related variables:

| Variable | Purpose |
| --- | --- |
| `SCIENCE_AGENT_PYPI_INDEX` | Python package index |
| `SCIENCE_AGENT_UV_INSTALL_INDEX` | Separate index for the uv wheel |
| `SCIENCE_AGENT_UV_PATH` | Use an existing uv executable |

For offline deployments, complete one first launch on a connected host and copy the whole data directory, or use reachable internal mirrors plus a preinstalled uv.

## Process relationships after launch

Single-file `serve` starts and supervises the required runtime components. The user-facing port remains 4310. See [Runtime architecture](architecture.md) for exact process boundaries, adapter/API relationships, and tool execution paths.

Bundled Python MCP servers are spawned on demand by the API rather than supervised as permanent launcher children.

Ctrl-C stops launcher-managed services in reverse startup order.

## Runner SEA

Remote Runner deployment uses a SEA single file with its own Node runtime. See [Deployment runtime internals](deployment-runtime.md) for upload, verification, lifecycle, and cleanup behavior.
