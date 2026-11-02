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

    # --- review follow-up cases (PR #720): the digest short-circuit and the
    # optional tests/ excludes decide "already patched" / "skip apply", and a
    # silent skip of a never-applied patch is the failure mode these pin. ---

    @staticmethod
    def _init_tagged_tree(root: Path):
        """A git tree with tag 'pinned' carrying pkg/a.py, b/ and tests/."""
        import subprocess

        src = root / "src"
        (src / "pkg").mkdir(parents=True)
        (src / "tests").mkdir()
        (src / "pkg" / "a.py").write_text("one\n", encoding="utf-8")
        (src / "tests" / "t.py").write_text("t\n", encoding="utf-8")
        git = ["git", "-C", str(src), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run(["git", "init", "-q", str(src)], check=True, capture_output=True)
        subprocess.run(git + ["add", "."], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "-m", "pinned"], check=True, capture_output=True)
        subprocess.run(git + ["tag", "pinned"], check=True, capture_output=True)
        return src

    def test_matching_manifest_digests_skip_apply_even_when_not_reversible(self):
        # (a) manifest digests match + patches not reversible -> apply is a
        # no-op (no per-patch reverse check can succeed when later patches
        # touch earlier hunks; the digest match IS the patched state).
        import subprocess

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            (patch_dir / "0001-modify.patch").write_text(
                "diff --git a/pkg/a.py b/pkg/a.py\n"
                "--- a/pkg/a.py\n"
                "+++ b/pkg/a.py\n"
                "@@ -1 +1 @@\n"
                "-one\n"
                "+two\n",
                encoding="utf-8",
            )
            # First apply builds the manifest over the patched tree.
            swarm_patches.process("apply", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), "two\n")
            # Delete the tag so restore_pinned cannot run (the wheel form has
            # no tag; the digest short-circuit is the only "already patched"
            # path). The manifest digests still match the tree, so apply must
            # short-circuit to a no-op — even though reverse-checking the
            # patch over the tree is also a skip here, the contract under test
            # is: matching digests + no tag => no error, no content change,
            # verify stays green.
            subprocess.run(["git", "-C", str(src), "tag", "-d", "pinned"], check=True, capture_output=True)
            before = (src / "pkg" / "a.py").read_text(encoding="utf-8")
            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), before)

    def _optional_patches(self, patch_dir: Path):
        modify = (
            "diff --git a/pkg/a.py b/pkg/a.py\n"
            "--- a/pkg/a.py\n"
            "+++ b/pkg/a.py\n"
            "@@ -1 +1 @@\n"
            "-one\n"
            "+two\n"
        )
        tests_only = (
            "diff --git a/tests/t.py b/tests/t.py\n"
            "--- a/tests/t.py\n"
            "+++ b/tests/t.py\n"
            "@@ -1 +1 @@\n"
            "-t\n"
            "+t2\n"
        )
        (patch_dir / "0001-modify.patch").write_text(modify, encoding="utf-8")
        (patch_dir / "0002-tests-only.patch").write_text(tests_only, encoding="utf-8")

    def test_tests_only_patch_noops_on_tree_without_tests(self):
        # (b) a patch whose only targets are tests/ on a tree without tests/
        # -> apply + verify succeed and the manifest omits them.
        import json
        import shutil

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            self._optional_patches(patch_dir)
            # Wheel form: drop tests/ entirely.
            shutil.rmtree(src / "tests")

            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), "two\n")
            manifest = json.loads((src / ".sciencediscovery-patches.json").read_text(encoding="utf-8"))
            self.assertNotIn("tests/t.py", manifest["files"])
            self.assertIn("pkg/a.py", manifest["files"])

    def test_mixed_patch_applies_product_hunks_and_skips_tests_on_wheel_tree(self):
        # (c) a mixed patch (product + tests targets) on a tree without
        # tests/ -> product hunks applied, tests hunks skipped.
        import shutil

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            (patch_dir / "0001-mixed.patch").write_text(
                "diff --git a/pkg/a.py b/pkg/a.py\n"
                "--- a/pkg/a.py\n"
                "+++ b/pkg/a.py\n"
                "@@ -1 +1 @@\n"
                "-one\n"
                "+two\n"
                "diff --git a/tests/t.py b/tests/t.py\n"
                "--- a/tests/t.py\n"
                "+++ b/tests/t.py\n"
                "@@ -1 +1 @@\n"
                "-t\n"
                "+t2\n",
                encoding="utf-8",
            )
            # Wheel form: no tests/.
            shutil.rmtree(src / "tests")

            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), "two\n")



if __name__ == "__main__":
    unittest.main()
