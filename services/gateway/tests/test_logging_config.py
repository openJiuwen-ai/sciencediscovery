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

from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path

from science_agent_gateway.logging_config import configure_logging


class GatewayLoggingTests(unittest.TestCase):
    def tearDown(self) -> None:
        logger = logging.getLogger("science_agent_gateway")
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            handler.close()

    def test_level_rotation_and_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            logger = configure_logging(
                {
                    "SCIENCE_AGENT_LOG_BACKUP_COUNT": "2",
                    "SCIENCE_AGENT_LOG_LEVEL": "WARNING",
                    "SCIENCE_AGENT_LOG_MAX_BYTES": "180",
                },
                data_dir=Path(temporary),
            )
            logger.info("event=ignored")
            for index in range(12):
                logger.error(
                    'event=failed index=%s api_key=top-secret JSON={"token":"json-secret"} value=%s',
                    index,
                    "x" * 40,
                )
            for handler in logger.handlers:
                handler.flush()

            log_dir = Path(temporary) / "logs"
            contents = "".join(path.read_text(encoding="utf-8") for path in log_dir.glob("gateway.log*"))
            self.assertNotIn("event=ignored", contents)
            self.assertNotIn("top-secret", contents)
            self.assertNotIn("json-secret", contents)
            self.assertIn("api_key=[REDACTED]", contents)
            self.assertTrue((log_dir / "gateway.log.1").exists())
            self.assertTrue((log_dir / "gateway.log.2").exists())
            self.assertFalse((log_dir / "gateway.log.3").exists())


if __name__ == "__main__":
    unittest.main()
