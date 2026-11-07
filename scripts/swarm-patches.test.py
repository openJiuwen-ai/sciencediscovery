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

    # --- merge-queue follow-up (PR #720): the wheel build patches the source
    # checkout, and the wheel it builds carries the patched tree WITHOUT the
    # manifest or tests/. Docker/binary payloads then install that wheel and
    # apply again. With later patches rewriting earlier hunks (the layered
    # chain does), the per-patch reverse check over the already-patched tree
    # fails and the release build dies. The fix ships the source tree's
    # manifest beside the wheel; the payload drops it into site-packages.
    # These cases pin that contract. ---

    def _layered_patches(self, patch_dir: Path):
        """A two-patch chain where the second rewrites the first's hunk.

        This is the shape that breaks the per-patch reverse check over a
        fully patched tree: reverse-checking 0001 needs the exact post-0001
        context, which 0002 has already rewritten. Only the digest
        short-circuit can recognize the patched state.
        """
        (patch_dir / "0001-first.patch").write_text(
            "diff --git a/pkg/a.py b/pkg/a.py\n"
            "--- a/pkg/a.py\n"
            "+++ b/pkg/a.py\n"
            "@@ -1 +1 @@\n"
            "-one\n"
            "+two\n",
            encoding="utf-8",
        )
        # 0002 rewrites the line 0001 produced (two -> three).
        (patch_dir / "0002-rewrites-first.patch").write_text(
            "diff --git a/pkg/a.py b/pkg/a.py\n"
            "--- a/pkg/a.py\n"
            "+++ b/pkg/a.py\n"
            "@@ -1 +1 @@\n"
            "-two\n"
            "+three\n",
            encoding="utf-8",
        )

    def test_wheel_manifest_short_circuits_double_apply_on_layered_chain(self):
        # The exact merge-queue failure shape: a wheel built from a patched
        # source checkout lands in site-packages (no tests/, no .git, no
        # manifest), and the build-swarm-wheel receipt (the SOURCE tree's
        # manifest, tests/ digests included) is dropped in beside it. Apply
        # must recognize the already-patched state (digest short-circuit,
        # absent optional paths tolerated) instead of dying in the reverse
        # checks; verify must stay green.
        import json
        import shutil

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            self._layered_patches(patch_dir)
            # Source-form apply: builds the manifest with tests/ digests.
            swarm_patches.process("apply", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), "three\n")

            # Wheel form: package files only, receipt dropped in.
            wheel_form = root / "site-packages"
            shutil.copytree(src / "pkg", wheel_form / "pkg")
            shutil.rmtree(wheel_form / "pkg" / "__pycache__", ignore_errors=True)
            # (the wheel omits tests/; nothing to copy)
            shutil.copy(src / ".sciencediscovery-patches.json",
                        wheel_form / ".sciencediscovery-patches.json")
            self.assertFalse((wheel_form / "tests").exists())
            self.assertFalse((wheel_form / ".git").exists())

            # The pre-fix behavior here was CalledProcessError from git apply
            # (0001 forward --check failed over the already-patched tree).
            swarm_patches.process("apply", wheel_form, "pinned", patch_dir)
            swarm_patches.process("verify", wheel_form, "pinned", patch_dir)
            self.assertEqual((wheel_form / "pkg" / "a.py").read_text(encoding="utf-8"), "three\n")
            # The wheel-form manifest keeps recording only carried files.
            manifest = json.loads((wheel_form / ".sciencediscovery-patches.json")
                                   .read_text(encoding="utf-8"))
            self.assertNotIn("tests/t.py", manifest["files"])
            self.assertIn("pkg/a.py", manifest["files"])

    def test_source_manifest_double_apply_still_short_circuits(self):
        # The source form of the same double apply: the SAME tree (tests/
        # present, .git present) applied again with its manifest intact.
        # The digest short-circuit must make the second apply a no-op even
        # though the layered chain's reverse checks cannot succeed.
        import subprocess

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            self._layered_patches(patch_dir)
            swarm_patches.process("apply", src, "pinned", patch_dir)
            before = (src / "pkg" / "a.py").read_text(encoding="utf-8")
            self.assertEqual(before, "three\n")

            # Second apply over the same tree: manifest matches, digests
            # match -> no-op (no restore, no per-patch checks).
            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), before)

            # And with the tag gone (a scratch tree that cannot restore),
            # the digest short-circuit is still the only path — apply must
            # stay a no-op rather than fail the un-reversible chain.
            subprocess.run(["git", "-C", str(src), "tag", "-d", "pinned"], check=True, capture_output=True)
            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertEqual((src / "pkg" / "a.py").read_text(encoding="utf-8"), before)



    # --- SIZEOPT follow-up (PR #834): the patch set gained root-level targets.
    # 0018 slims the dependency set and 0019 aligns workspace versions, both of
    # which live in the checkout's root pyproject.toml and uv.lock. Neither file
    # is inside the package, so a wheel install (site-packages) carries neither,
    # and the required-paths check hard-failed on exactly the form the release
    # builds install:
    #   ValueError: missing patch target(s): ..., pyproject.toml, uv.lock
    # The existing wheel-form cases above only ever touch pkg/a.py, so they
    # could not catch it. These pin a patch that reaches the repository root. ---

    @staticmethod
    def _init_tagged_tree_with_root_manifests(root: Path):
        """A tagged tree carrying package files AND root build metadata."""
        import subprocess

        src = root / "src"
        (src / "pkg").mkdir(parents=True)
        (src / "tests").mkdir()
        (src / "pkg" / "a.py").write_text("one\n", encoding="utf-8")
        (src / "tests" / "t.py").write_text("t\n", encoding="utf-8")
        (src / "pyproject.toml").write_text("[project]\ndependencies = ['heavy']\n", encoding="utf-8")
        (src / "uv.lock").write_text("version = 1\nheavy = '1.0'\n", encoding="utf-8")
        git = ["git", "-C", str(src), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run(["git", "init", "-q", str(src)], check=True, capture_output=True)
        subprocess.run(git + ["add", "."], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "-m", "pinned"], check=True, capture_output=True)
        subprocess.run(git + ["tag", "pinned"], check=True, capture_output=True)
        return src

    @staticmethod
    def _root_manifest_patches(patch_dir: Path):
        """The 0018/0019 shape: one mixed patch, one root-only patch."""
        # Mixed, like 0018: an in-package hunk plus root build metadata.
        (patch_dir / "0018-slim-deps.patch").write_text(
            "diff --git a/pkg/a.py b/pkg/a.py\n"
            "--- a/pkg/a.py\n"
            "+++ b/pkg/a.py\n"
            "@@ -1 +1 @@\n"
            "-one\n"
            "+two\n"
            "diff --git a/pyproject.toml b/pyproject.toml\n"
            "--- a/pyproject.toml\n"
            "+++ b/pyproject.toml\n"
            "@@ -1,2 +1,2 @@\n"
            " [project]\n"
            "-dependencies = ['heavy']\n"
            "+dependencies = []\n",
            encoding="utf-8",
        )
        # Root-only, like 0019: nothing of it survives into a wheel.
        (patch_dir / "0019-align-versions.patch").write_text(
            "diff --git a/uv.lock b/uv.lock\n"
            "--- a/uv.lock\n"
            "+++ b/uv.lock\n"
            "@@ -1,2 +1,2 @@\n"
            " version = 1\n"
            "-heavy = '1.0'\n"
            "+heavy = '1.1'\n",
            encoding="utf-8",
        )

    def test_root_manifest_targets_are_optional_on_a_wheel_tree(self):
        # Wheel form: site-packages carries the package but no root
        # pyproject.toml / uv.lock. Apply must not report them missing; the
        # in-package hunk still applies, the root-only patch no-ops, and
        # verify stays green with the manifest recording only carried files.
        import json
        import shutil

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree_with_root_manifests(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            self._root_manifest_patches(patch_dir)

            wheel_form = root / "site-packages"
            shutil.copytree(src / "pkg", wheel_form / "pkg")
            shutil.rmtree(wheel_form / "pkg" / "__pycache__", ignore_errors=True)
            self.assertFalse((wheel_form / "pyproject.toml").exists())
            self.assertFalse((wheel_form / "uv.lock").exists())

            # Pre-fix this raised ValueError: missing patch target(s).
            swarm_patches.process("apply", wheel_form, "pinned", patch_dir)
            swarm_patches.process("verify", wheel_form, "pinned", patch_dir)
            self.assertEqual((wheel_form / "pkg" / "a.py").read_text(encoding="utf-8"), "two\n")
            manifest = json.loads((wheel_form / ".sciencediscovery-patches.json")
                                   .read_text(encoding="utf-8"))
            self.assertNotIn("pyproject.toml", manifest["files"])
            self.assertNotIn("uv.lock", manifest["files"])
            self.assertIn("pkg/a.py", manifest["files"])

    def test_root_manifest_targets_still_apply_on_a_source_tree(self):
        # Optional means "a wheel legitimately lacks it", never "skip it when
        # it is there". The source checkout carries both files, so both hunks
        # must land and both must be recorded in the manifest.
        import json

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree_with_root_manifests(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            self._root_manifest_patches(patch_dir)

            swarm_patches.process("apply", src, "pinned", patch_dir)
            swarm_patches.process("verify", src, "pinned", patch_dir)
            self.assertIn("dependencies = []", (src / "pyproject.toml").read_text(encoding="utf-8"))
            self.assertIn("heavy = '1.1'", (src / "uv.lock").read_text(encoding="utf-8"))
            manifest = json.loads((src / ".sciencediscovery-patches.json").read_text(encoding="utf-8"))
            self.assertIn("pyproject.toml", manifest["files"])
            self.assertIn("uv.lock", manifest["files"])

    def test_a_missing_root_target_outside_the_optional_list_still_fails(self):
        # The optional list is exact, so a root-level target outside it keeps
        # the diagnostic that catches a genuinely stale JIUWENSWARM_ROOT.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = self._init_tagged_tree_with_root_manifests(root)
            patch_dir = root / "patches"
            patch_dir.mkdir()
            (patch_dir / "0020-other-root-file.patch").write_text(
                "diff --git a/setup.cfg b/setup.cfg\n"
                "--- a/setup.cfg\n"
                "+++ b/setup.cfg\n"
                "@@ -1 +1 @@\n"
                "-old\n"
                "+new\n",
                encoding="utf-8",
            )
            # setup.cfg is root-level but not optional metadata: a tree that
            # lacks it is the wrong JiuwenSwarm, not a wheel.
            self.assertFalse((src / "setup.cfg").exists())
            with self.assertRaisesRegex(ValueError, r"missing patch target\(s\): setup\.cfg"):
                swarm_patches.process("apply", src, "pinned", patch_dir)


if __name__ == "__main__":
    unittest.main()
