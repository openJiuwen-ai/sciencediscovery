# Third-party provenance

The Skill wrapper (`scripts/`, `SKILL.md`, references) is distinct from the upstream [ScienceFlow](https://github.com/science-learner/ScienceFlow) project.

Bundled upstream `assets/repo.zip`, when present, is redistributed under the corresponding upstream `LICENSE` file (MIT as of 2026-10-28). Preserve that file in the archive and ensure relevant upstream copyright/license notices remain intact. The packaging script rejects archives lacking `LICENSE` but cannot conduct a full legal or security audit. Additional third-party license and dependency obligations remain with the redistributor.

A release should identify a pinned Git commit/tag with `--upstream-ref`, check the SHA-256 recorded in `assets/source-manifest.json`, and disclose any upstream modifications. A mutable branch tip does not provide reproducible revisions.
