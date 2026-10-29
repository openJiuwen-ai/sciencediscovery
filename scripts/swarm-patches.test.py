"""Regression tests for JiuwenSwarm compatibility-patch setup diagnostics."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("swarm-patches.py")
SPEC = importlib.util.spec_from_file_location("swarm_patches", SCRIPT)
swarm_patches = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(swarm_patches)


class SwarmPatchesTest(unittest.TestCase):
    def test_new_patch_file_is_not_treated_as_a_missing_source_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            patch = patch_dir / "new-file.patch"
            patch.write_text(
                "diff --git a/created.py b/created.py\n"
                "new file mode 100644\n"
                "--- /dev/null\n"
                "+++ b/created.py\n"
                "@@ -0,0 +1 @@\n"
                "+created\n",
                encoding="utf-8",
            )
            self.assertEqual(swarm_patches.patch_paths([patch], "---"), [])
            self.assertEqual(swarm_patches.patch_paths([patch], "+++"), ["created.py"])

    def test_missing_patch_target_names_pinned_revision_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            (patch_dir / "missing.patch").write_text(
                "diff --git a/removed.py b/removed.py\n"
                "--- a/removed.py\n"
                "+++ b/removed.py\n"
                "@@ -0,0 +1 @@\n"
                "+replacement\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValueError,
                r"workswarm0\.2\.6.*missing patch target\(s\): removed\.py.*JIUWENSWARM_ROOT",
            ):
                swarm_patches.process("apply", root, "workswarm0.2.6", patch_dir)



if __name__ == "__main__":
    unittest.main()
