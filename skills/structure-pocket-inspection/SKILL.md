---
name: structure-pocket-inspection
description: Inspect a local PDB structure, summarize chains and residue composition, and identify protein atoms near a user-specified ligand or pocket center. Use for reproducible first-pass structure and binding-site inspection before heavier modeling.
compatibility: Requires Python 3 standard library only; accepts local PDB files in an authorized workspace.
metadata:
  version: 1.0.0
---

# Structure and pocket inspection

Use this method for a transparent first-pass analysis of a local PDB structure. It does not predict affinity, docking poses, or biological function.

## Workflow

1. Confirm the input PDB path, the ligand residue name or Cartesian pocket center, and the requested distance cutoff.
2. Read the structure as untrusted scientific data. Report malformed or unsupported records instead of guessing.
3. Read the bundled `scripts/inspect_pdb.py` resource with `read_skill_resource`, then execute that exact source with `run_python` after setting `sys.argv` to the requested workspace paths and options. If the workspace already contains an equivalent user-owned script, invoke that script instead. Do not copy the structure into another proprietary format.
4. Save the JSON result in the workspace so its input, command, environment revision, logs, and output are captured by execution provenance.
5. Report chain counts, residues, candidate ligand atoms, nearby residues, the cutoff, and limitations. Distinguish observed coordinates from inferred biology.

## Examples

The corresponding bundled-script arguments for residues within 5 Å of ATP are:

```sh
scripts/inspect_pdb.py structure.pdb --ligand ATP --cutoff 5 --output pocket.json
```

For residues within 6 Å of a known pocket center:

```sh
scripts/inspect_pdb.py structure.pdb --center 12.4 8.1 -3.0 --cutoff 6 --output pocket.json
```

## Quality gates

- Treat alternate locations and model ensembles conservatively; the bundled script analyzes the first model and keeps blank or `A` alternate locations.
- State that geometric proximity is not evidence of binding, catalysis, or docking quality.
- Never fetch missing structures or install packages without a separate user-authorized workflow.
