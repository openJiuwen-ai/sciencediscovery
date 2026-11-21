---
name: scienceflow-runtime
description: Install and operate ScienceFlow scientific research agent from a locally bundled, sanitized upstream source archive, especially in ScienceDiscovery or restricted networks without GitHub access. Use for reproducible local setup, dependency diagnostics, private model API configuration, and launching ScienceFlow CLI. Do not claim offline dependency installation without a wheelhouse or a real run without executing it.
---

# ScienceFlow Runtime

Prepare a **writable** working directory from the **read-only** Skill bundle. The Skill is an installer/workflow, not an automatic installer, and this wrapper is not the upstream ScienceFlow project.

## Preconditions

1. Discover this package directory from the agent-provided Skill path (or `${SCIENCEDISCOVERY_SKILLS_DIR}/scienceflow-runtime`). Do not assume `/skills` or a fixed Python interpreter.
2. Look for `assets/repo.zip`. If missing, inform the user that this is the template-only edition and request a source archive or invoke `--repo-zip PATH`. **Do not silently `git clone`**.
3. Verify a writable work directory and Python 3.11–3.13.
4. Do not read, disclose, or publish `.env`/API tokens. Never pass secrets via command line or paste them into reports.

## Offline Installation (Recommended)

The vendor directory at `vendor/` contains a complete offline wheelhouse and installer scripts.
**No network access is required** for installation -- all dependencies are bundled.

### Prepare (run once when building the Skill bundle)

```bash
bash "$SKILL_DIR/scripts/prepare-offline.sh"
```

This downloads wheels into `vendor/wheels/`. A pre-prepared bundle will already have this populated.

### Offline Install

```bash
bash "$SKILL_DIR/scripts/install-offline.sh" --target ./sf_runtime
```

The script:
- Creates a Python virtual environment at `<target>/.venv`
- Extracts `assets/repo.zip` to `<target>/repo`
- Installs all Python packages from `vendor/wheels/` using `--no-index`
- Verifies the `scienceflow` package imports and CLI works

### Verify

```bash
bash "$SKILL_DIR/scripts/verify-offline.sh" --target ./sf_runtime
```

### Smoke Test

```bash
bash "$SKILL_DIR/scripts/run-smoke-test.sh" --target ./sf_runtime
```

## Procedure (with network)

From the package directory (`SKILL_DIR` below), run:

```bash
python3 "$SKILL_DIR/scripts/install.py" --target ./sf_runtime
# In fully offline settings provide --offline --wheelhouse /path/to/wheels
python3 "$SKILL_DIR/scripts/doctor.py" --target ./sf_runtime --check-cli
```

For user model APIs, follow `references/api-configuration.md`. The current upstream (v0.2) registry is a **private** `~/.config/scienceflow/models.json`, not the old YAML template.

```bash
python3 "$SKILL_DIR/scripts/configure_api.py" --env-file "$HOME/.config/scienceflow-runtime/api.env"
python3 "$SKILL_DIR/scripts/run.py" --target ./sf_runtime -- --help
python3 "$SKILL_DIR/scripts/run.py" --target ./sf_runtime -- tui
```

Model/API calls and task execution require a configured, working endpoint and appropriate task dependencies. Always distinguish successful source extraction, dependency install, CLI smoke test, and an actual completed research run.

## Operating boundaries

- Prefer the built-in `scienceflow` CLI from the pinned local source. It is distinct from the historical, external `sfctl.py` companion Skill.
- Do **not** assume the legacy `sfctl.py start ... --config llm_proxy.yaml` flags exist in current upstream.
- For task-specific GPU/ML dependencies, install only required extras after confirming hardware/toolchain. Default `pip install -e repo/` installs the base control plane, not every task environment.
- Do not modify source or skip tests silently to handle a dependency error. Report the exact missing dependency, Python version, and remediation.
- Never run unreviewed upstream source with elevated privileges or publish runtime output containing datasets, logs or credentials.

## Resources

- `README.md`: full installation and publishing guide.
- `references/api-configuration.md`: private keys, OpenAI-compatible endpoints, proxy and special Authorization headers.
- `references/troubleshooting.md`: common failures and diagnostic steps.
- `references/sciencediscovery.md`: import/read-only sandbox constraints.
- `scripts/package_release.py`: sanitize a user-supplied `repo.zip` and build an importable release.
