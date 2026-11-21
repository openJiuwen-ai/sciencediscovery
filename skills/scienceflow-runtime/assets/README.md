# Bundled source

For a complete runnable Skill release, `repo.zip` must be added **using** `scripts/package_release.py`. Never copy a raw source archive with `.env`/API keys directly into a public package.

`repo.zip` is absent from the template. Build a full release with `--github-ref <commit>` or `--repo-zip ./repo.zip`. GitHub is only required on the *release-builder* machine, never during normal Skill install.

Accepted layouts inside `repo.zip`:
- `ScienceFlow-master/pyproject.toml` and `ScienceFlow-master/scienceflow/`
- `pyproject.toml` and `scienceflow/` at archive root

The installer automatically identifies the project root and verifies its files. Python dependencies are *not* included in the source ZIP.
