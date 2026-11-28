# ScienceFlow Offline Distribution

This directory contains everything needed to install ScienceFlow v0.2 without any network access.

## Structure

```
vendor/
  wheels/            # Pre-downloaded Python wheel files (manylinux2014_x86_64, Python 3.12)
  offline-manifest.txt  # List of all bundled wheels
  SHA256SUMS           # SHA-256 checksums for all wheel files
  bin/                # (reserved for additional offline binaries if needed)
  sources/            # (reserved for source tarballs if needed)
```

## Requirements (must be available on target machine)

- **Python 3.11, 3.12, or 3.13** with `venv` module
- **bash** shell
- **No network access required**

## Installation

```bash
# From the Skill directory:
bash scripts/install-offline.sh --target ./sf_runtime

# Verify:
bash scripts/verify-offline.sh --target ./sf_runtime

# Smoke test:
bash scripts/run-smoke-test.sh --target ./sf_runtime
```

## What's included

- 57 Python wheel files covering all direct and transitive dependencies of ScienceFlow
- The upstream ScienceFlow source archive (`assets/repo.zip`)
- ScienceFlow v0.2 base control plane (lightweight, CPU-only)

## What's NOT included (must be available separately)

- GPU/ML task dependencies (PyTorch, transformers, etc.) — install via extras after networking restored
- MLEBench evaluation harness — Git dependency, needs network
- CUDA runtime/drivers — require target OS installation
- System libraries (libffi, OpenSSL, etc.) — assumed present on standard Linux distributions

## Preparing for distribution

```bash
bash scripts/prepare-offline.sh
```

This populates `vendor/wheels/` and regenerates `SHA256SUMS`. Run it whenever `pyproject.toml` dependencies change.

## Verification

```bash
sha256sum -c vendor/SHA256SUMS
# All files should report OK
```

## License

ScienceFlow: MIT (see `LICENSE` in the source archive).
Individual Python packages may have their own licenses (see `THIRD_PARTY.md`).
