# Troubleshooting (diagnose rather than silently patch)

| Symptom | Likely cause and action |
|---|---|
| Missing `assets/repo.zip` | You imported a template-only package. Run `package_release.py --repo-zip ...` or pass `--repo-zip` to `install.py`. |
| `Permission denied` below Skill | ScienceDiscovery stages packages read-only. Always use `--target` in a writable workspace. |
| Import exceeds ZIP limit | Nested source archive must be <=10 MiB and import <=25 MiB. Use template Skill plus separately placed source if larger. |
| `Python version unsupported` | Modern upstream requires Python 3.11–3.13. Choose compatible `--python`. |
| `No module named click` / CLI unavailable | Dependency installation incomplete or wrong interpreter. Execute generated `.venv/bin/scienceflow` via `run.py`. |
| `pip` times out / GitHub unavailable | Source was bundled but Python dependencies are not. Configure PyPI mirror/proxy or use `--offline --wheelhouse ...`. Old `pyproject.toml` may contain Git-sourced dependencies. |
| `No module named pyquaternion` | A task dependency is missing; prepare the appropriate extra or a wheelhouse before reinstalling. Do not automatically download Git-based optional extras. |
| `scienceflow config ...` changes | Upstream CLI revision mismatch. Inspect `install-manifest.json` and `scienceflow --help` from the local environment. |
| LLM 401 | Confirm the model registry, URL and actual bearer token. Dummy `api_key` and a separate gateway header are not automatically interchangeable. |
| LLM gateway proxy failure | Check `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`; `SF_USE_PROXY` is opt-in. |
| Research task fails / missing artifact | Task data/evaluator/GPU dependency or insufficient worker duration. Follow actual task logs; successful CLI setup is not a successful research run. |
