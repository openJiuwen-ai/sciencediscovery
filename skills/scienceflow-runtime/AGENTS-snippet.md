# ScienceFlow Runtime Skill — Agent usage snippet

When the user asks to use ScienceFlow, first read `scienceflow-runtime/SKILL.md`. Resolve the staged package from the runtime-advertised package path or `${SCIENCEDISCOVERY_SKILLS_DIR}/scienceflow-runtime`. Do not hardcode `/skills` or assume the Skill is writable.

Use `python3 <skill_dir>/scripts/install.py --target ./sf_runtime` to deploy bundled sources into a writable workspace, `doctor.py` for local checks, `configure_api.py` for a private registry, and `run.py` for the pinned upstream CLI. Missing bundled archive or dependency wheels are prerequisites to report explicitly. Do not silently fetch Git repositories or expose API credentials.
