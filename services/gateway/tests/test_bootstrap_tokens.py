# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The gateway resolves its internal credential the same way the API does."""

from __future__ import annotations

import stat
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from science_agent_gateway.bootstrap_tokens import (
    GATEWAY_INTERNAL_TOKEN_FILE,
    bootstrap_token_path,
    load_or_create_token,
    resolve_internal_token,
)
from science_agent_gateway.bootstrap_tokens import resolve_internal_token as _internal_token


class BootstrapTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self._workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self._workspace.cleanup)
        self.data_dir = Path(self._workspace.name)
        self.token_path = bootstrap_token_path(self.data_dir, GATEWAY_INTERNAL_TOKEN_FILE)

    def _env(self, **overrides: str) -> dict[str, str]:
        return {"SCIENCE_AGENT_DATA_DIR": str(self.data_dir), **overrides}

    def test_first_start_generates_and_stores_a_private_token(self) -> None:
        token = resolve_internal_token(self._env())

        self.assertGreaterEqual(len(token), 32)
        self.assertNotEqual(token, "science-agent-gateway-local")
        self.assertEqual(self.token_path.read_text(encoding="utf-8").strip(), token)
        self.assertEqual(stat.S_IMODE(self.token_path.stat().st_mode), 0o600)

    def test_restart_reuses_the_stored_token(self) -> None:
        first = resolve_internal_token(self._env())

        self.assertEqual(resolve_internal_token(self._env()), first)

    def test_explicit_environment_value_wins_and_is_not_stored(self) -> None:
        token = resolve_internal_token(
            self._env(SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN="  operator-token  ")
        )

        self.assertEqual(token, "operator-token")
        self.assertFalse(self.token_path.exists())

    def test_explicit_value_overrides_a_stored_token(self) -> None:
        stored = resolve_internal_token(self._env())

        token = resolve_internal_token(
            self._env(SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN="operator-token")
        )

        self.assertEqual(token, "operator-token")
        self.assertEqual(self.token_path.read_text(encoding="utf-8").strip(), stored)

    def test_a_blank_stored_token_is_replaced(self) -> None:
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text("  \n", encoding="utf-8")

        token = load_or_create_token(self.token_path)

        self.assertTrue(token.strip())
        self.assertEqual(self.token_path.read_text(encoding="utf-8").strip(), token)

    def test_reads_back_a_token_the_control_plane_created(self) -> None:
        # The Node side writes "<token>\n" to the same path; whichever service
        # starts first wins, and the other must accept that value.
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text("token-written-by-node\n", encoding="utf-8")

        self.assertEqual(resolve_internal_token(self._env()), "token-written-by-node")

    def test_the_request_dependency_no_longer_falls_back_to_a_fixed_value(self) -> None:
        # `_internal_token` reads the process environment; with no explicit
        # variable it must never hand out the retired shared literal.
        with unittest.mock.patch.dict(
            "os.environ",
            {"SCIENCE_AGENT_DATA_DIR": str(self.data_dir)},
            clear=True,
        ):
            token = _internal_token()

        self.assertNotEqual(token, "science-agent-gateway-local")
        self.assertEqual(self.token_path.read_text(encoding="utf-8").strip(), token)

    def test_the_file_contract_matches_the_node_implementation(self) -> None:
        # The stored-file layout is the whole cross-language contract: if the
        # Node side renames a file or the directory, this must fail loudly.
        source = Path(__file__).resolve().parents[2] / "api/src/http/bootstrap-tokens.ts"
        text = source.read_text(encoding="utf-8")

        self.assertIn('BOOTSTRAP_SECRETS_DIRECTORY = "secrets"', text)
        self.assertIn('AUTH_TOKEN_FILE = "auth-token"', text)
        self.assertIn(f'GATEWAY_INTERNAL_TOKEN_FILE = "{GATEWAY_INTERNAL_TOKEN_FILE}"', text)


if __name__ == "__main__":
    unittest.main()
