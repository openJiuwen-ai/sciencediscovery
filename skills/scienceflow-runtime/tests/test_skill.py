"""stdlib-only tests; no network or actual ScienceFlow source needed."""
from __future__ import annotations
import importlib.util
import json
import io
from unittest.mock import patch
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from configure_api import build_registry, parse_env_file
from install import safe_extract


def fixture(path: Path, unsafe: bool = False) -> Path:
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('ScienceFlow-master/pyproject.toml',
                   '[project]\nname="scienceflow"\nversion="0.2.0"\n')
        z.writestr('ScienceFlow-master/scienceflow/__init__.py', '')
        z.writestr('ScienceFlow-master/LICENSE', 'MIT License')
        z.writestr('ScienceFlow-master/.env', 'CODE_API_KEY=TOP_SECRET_SHOULD_NOT_LEAK')
        z.writestr('ScienceFlow-master/.git/config', 'private@example.com')
        if unsafe:
            z.writestr('../bad', 'bad')
    return path


class Tests(unittest.TestCase):
    def test_source_only_install_with_real_archive_layout(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            sample = fixture(base / 'repo.zip')
            target = base / 'runtime'
            cmd = [sys.executable, str(SCRIPTS / 'install.py'), '--target', str(target),
                   '--repo-zip', str(sample), '--no-install']
            for _ in range(2):
                out = subprocess.run(cmd, check=True, capture_output=True, text=True)
            self.assertTrue((target / 'repo/scienceflow/__init__.py').is_file())
            self.assertFalse((target / 'repo/.env').exists())
            self.assertFalse((target / 'repo/.git').exists())
            self.assertEqual(json.loads((target / 'install-manifest.json').read_text())['upstream_version'], '0.2.0')

    def test_reject_path_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            sample = fixture(Path(d) / 'repo.zip', unsafe=True)
            with self.assertRaises(ValueError):
                safe_extract(sample, Path(d) / 'out')

    def test_release_strips_secrets(self):
        from package_release import sanitized_repo_zip
        with tempfile.TemporaryDirectory() as d:
            sample = fixture(Path(d) / 'repo.zip')
            archive, meta = sanitized_repo_zip(sample)
            self.assertEqual(meta['upstream_version'], '0.2.0')
            with zipfile.ZipFile(__import__('io').BytesIO(archive)) as zipf:
                self.assertIn('LICENSE', zipf.namelist())
                self.assertNotIn('.env', zipf.namelist())
                self.assertNotIn('.git/config', zipf.namelist())
            self.assertNotIn(b'TOP_SECRET_SHOULD_NOT_LEAK', archive)

    def test_registry_and_env(self):
        with tempfile.TemporaryDirectory() as d:
            config = Path(d) / 'env'
            config.write_text('SF_API_KEY="with spaces and = equals"\n')
            self.assertEqual(parse_env_file(config)['SF_API_KEY'], 'with spaces and = equals')
        obj = build_registry({'SF_MODEL':'test-code', 'SF_BASE_URL':'https://example.org/v1',
                              'SF_API_KEY':'SENSITIVE', 'SF_FEEDBACK_MODEL':'test-feedback',
                              'SF_FEEDBACK_API_KEY':'DIFFERENT', 'SF_USE_PROXY':'yes'})
        self.assertEqual(obj['models']['test-code']['endpoints']['code'][0]['key'], 'SENSITIVE')
        self.assertEqual(obj['models']['test-feedback']['endpoints']['feedback'][0]['key'], 'DIFFERENT')
        self.assertEqual(obj['defaults']['code_models'], ['test-code'])


if __name__ == '__main__':
    unittest.main()

# Keep the main unittest block above for normal discovery; extra tests below are
# still discovered by python -m unittest discover.
class ReleaseIntegrationTests(unittest.TestCase):
    def test_published_archive_can_prepare_source(self):
        from package_release import build
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = fixture(root / 'repo.zip')
            output = root / 'skill.zip'
            result = build(output, source, 'fixture-commit')
            self.assertTrue(result['bundled_upstream'])
            with zipfile.ZipFile(output) as package:
                nested = package.read('scienceflow-runtime/assets/repo.zip')
                with zipfile.ZipFile(__import__('io').BytesIO(nested)) as z:
                    self.assertNotIn('.env', z.namelist())
                    self.assertIn('LICENSE', z.namelist())
                package.extractall(root / 'unpacked')
            script = root / 'unpacked/scienceflow-runtime/scripts/install.py'
            target = root / 'out'
            done = subprocess.run([sys.executable, str(script), '--target', str(target),
                                   '--no-install'], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)

    def test_private_registry_file_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            envfile = root / 'secrets.env'
            envfile.write_text('SF_MODEL=test\nSF_BASE_URL=https://gateway.example/v1\nSF_API_KEY=secret\n')
            output = root / 'models.json'
            done = subprocess.run([sys.executable, str(SCRIPTS / 'configure_api.py'),
                                   '--env-file', str(envfile), '--output', str(output)],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertNotIn('secret', done.stdout)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(output.read_text())['defaults']['code_models'], ['test'])

class GithubArchiveTests(unittest.TestCase):
    def test_github_download_from_pinned_commit(self):
        from package_release import fetch_github_archive
        with tempfile.TemporaryDirectory() as d:
            source = fixture(Path(d) / 'fixture.zip')
            fake_data = source.read_bytes()
            class Response(io.BytesIO):
                def __enter__(self):
                    return self
                def __exit__(self, *_):
                    self.close()
            ref = '8eb1ded20e5a98d3f5b5760d036e45e3ee2d6f3d'
            output = Path(d) / 'fetched.zip'
            with patch('package_release.urlopen', return_value=Response(fake_data)) as client:
                self.assertEqual(fetch_github_archive(ref, output), ref)
                self.assertIn(ref, client.call_args.args[0].full_url)
            self.assertEqual(output.read_bytes(), fake_data)

    def test_github_ref_validation(self):
        from package_release import fetch_github_archive
        with tempfile.TemporaryDirectory() as d:
            for bad in ('../passwd', 'http://malicious', '--bad', ''):
                with self.assertRaises(ValueError):
                    fetch_github_archive(bad, Path(d) / 'bad.zip')
