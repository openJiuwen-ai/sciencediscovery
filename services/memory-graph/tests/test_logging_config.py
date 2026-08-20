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
from unittest.mock import patch

from sciencediscovery_memory_graph.logging_config import get_logger


class MemoryGraphLoggingTests(unittest.TestCase):
    def test_uses_data_logs_with_rotation_and_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch.dict(
            "os.environ",
            {
                "SCIENCE_AGENT_DATA_DIR": temporary,
                "SCIENCE_AGENT_LOG_BACKUP_COUNT": "2",
                "SCIENCE_AGENT_LOG_MAX_BYTES": "180",
                "SCIENCE_AGENT_MEMORY_GRAPH_ENABLED": "1",
            },
            clear=False,
        ):
            logger = get_logger("operational_logging_test")
            try:
                for index in range(12):
                    logger.error(
                        'event=failed index=%s token=top-secret JSON={"apiKey":"json-secret"} value=%s',
                        index,
                        "x" * 40,
                    )
                for handler in logger.handlers:
                    handler.flush()

                log_dir = Path(temporary) / "logs"
                contents = "".join(path.read_text(encoding="utf-8") for path in log_dir.glob("memory-graph.log*"))
                self.assertNotIn("top-secret", contents)
                self.assertNotIn("json-secret", contents)
                self.assertIn("token=[REDACTED]", contents)
                self.assertTrue((log_dir / "memory-graph.log.1").exists())
                self.assertTrue((log_dir / "memory-graph.log.2").exists())
            finally:
                for handler in logger.handlers[:]:
                    logger.removeHandler(handler)
                    handler.close()
                logging.Logger.manager.loggerDict.pop(logger.name, None)


if __name__ == "__main__":
    unittest.main()
