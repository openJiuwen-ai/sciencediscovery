#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from importlib.metadata import PackageNotFoundError
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_managed_environment.py")
SPEC = importlib.util.spec_from_file_location("validate_managed_environment", SCRIPT)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class ManagedEnvironmentValidationTests(unittest.TestCase):
    def requirements(self) -> list:
        return [
            validator.Requirement("numpy", "1.26.4"),
            validator.Requirement("jinja2", None),
            validator.Requirement("fsspec", "2026.7.0"),
        ]

    def test_requirements_file_is_the_dependency_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.txt"
            path.write_text("# comment\nnumpy==1.26.4\njinja2\n", encoding="utf-8")
            self.assertEqual(
                validator.read_requirements(path),
                [validator.Requirement("numpy", "1.26.4"), validator.Requirement("jinja2", None)],
            )

    def test_import_name_exceptions(self) -> None:
        self.assertEqual(validator.import_name("biopython"), "Bio")
        self.assertEqual(validator.import_name("scikit-learn"), "sklearn")
        self.assertEqual(validator.import_name("protobuf"), "google.protobuf")

    def test_complete_environment_passes(self) -> None:
        installed = {"numpy": "1.26.4", "jinja2": "3.1.6", "fsspec": "2026.7.0"}
        errors = validator.validate_environment(
            self.requirements(),
            importer=lambda _name: object(),
            distribution_version=lambda name: installed[name],
        )
        self.assertEqual(errors, [])

    def test_broken_import_is_reported(self) -> None:
        def importer(name: str) -> object:
            if name == "jinja2":
                raise ModuleNotFoundError("No module named 'jinja2'")
            return object()

        installed = {"numpy": "1.26.4", "jinja2": "3.1.6", "fsspec": "2026.7.0"}
        errors = validator.validate_environment(
            self.requirements(),
            importer=importer,
            distribution_version=lambda name: installed[name],
        )
        self.assertTrue(any("cannot import jinja2" in error for error in errors), errors)

    def test_missing_distribution_and_version_mismatch_are_reported(self) -> None:
        def distribution_version(name: str) -> str:
            if name == "fsspec":
                raise PackageNotFoundError(name)
            if name == "numpy":
                return "2.0.0"
            return "3.1.6"

        errors = validator.validate_environment(
            self.requirements(),
            importer=lambda _name: object(),
            distribution_version=distribution_version,
        )
        self.assertIn("missing distribution fsspec==2026.7.0", errors)
        self.assertIn("numpy==2.0.0; required 1.26.4", errors)


if __name__ == "__main__":
    unittest.main()
