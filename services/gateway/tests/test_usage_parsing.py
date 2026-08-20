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

import unittest
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage

from science_agent_gateway.server import (
    SkillResourceSpec,
    SkillSpec,
    _final_openai_messages,
    _build_describe_skill_tool,
    _run_error_frame,
    _usage_from_mapping,
)


class UsageParsingTests(unittest.TestCase):
    def test_run_error_frame_preserves_generic_error_classes_without_details(self) -> None:
        marker = "private-provider-module"
        cases = [
            (TimeoutError(f"{marker} timed out"), "timeout"),
            (RuntimeError(f"{marker} HTTP 401 unauthorized"), "unauthorized"),
            (RuntimeError(f"{marker} HTTP 429 rate limit"), "rate-limited"),
            (RuntimeError(f"{marker} HTTP 503 server error"), "server-error"),
            (ConnectionError(f"{marker} connection reset"), "transport-error"),
            (RuntimeError(f"{marker} invalid response"), "semantic-error"),
        ]
        for error, expected_code in cases:
            with self.subTest(expected_code):
                frame = _run_error_frame(error)
                self.assertEqual(frame["code"], expected_code)
                self.assertNotIn(marker, frame["message"])

    def test_usage_from_mapping_includes_cache_tokens(self) -> None:
        usage = _usage_from_mapping(
            {
                "input_tokens": 20,
                "output_tokens": 5,
                "total_tokens": 25,
                "cache_read_input_tokens": 8,
                "cache_creation_input_tokens": 2,
            }
        )
        self.assertEqual(
            usage,
            {
                "input_tokens": 20,
                "output_tokens": 5,
                "total_tokens": 25,
                "cache_read_tokens": 8,
                "cache_write_tokens": 2,
            },
        )

    def test_usage_from_mapping_reads_prompt_token_details_cache(self) -> None:
        usage = _usage_from_mapping(
            {
                "prompt_tokens": 11,
                "completion_tokens": 4,
                "total_tokens": 15,
                "prompt_tokens_details": {"cached_tokens": 3},
            }
        )
        assert usage is not None
        self.assertEqual(usage["cache_read_tokens"], 3)
        self.assertNotIn("cache_write_tokens", usage)

    def test_usage_from_mapping_accepts_prompt_cache_aliases(self) -> None:
        usage = _usage_from_mapping(
            {
                "prompt_tokens": 20,
                "completion_tokens": 5,
                "prompt_cache_hit_tokens": 8,
                "prompt_cache_miss_tokens": 2,
            }
        )
        assert usage is not None
        self.assertEqual(usage["total_tokens"], 25)
        self.assertEqual(usage["cache_read_tokens"], 8)
        self.assertEqual(usage["cache_write_tokens"], 2)

    def test_usage_from_mapping_rejects_incomplete_usage(self) -> None:
        self.assertIsNone(_usage_from_mapping({"input_tokens": 3}))

    def test_final_openai_messages_carries_summary_text_as_checkpoint(self) -> None:
        messages = _final_openai_messages(
            {
                "messages": [
                    HumanMessage(content="recent user"),
                    AIMessage(content="recent assistant"),
                ],
                "summary_text": "earlier work summary",
            }
        )

        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[0]["name"], "summary")
        self.assertIn("earlier work summary", messages[0]["content"])
        self.assertTrue(messages[0]["additional_kwargs"]["hide_from_ui"])
        self.assertEqual([message["content"] for message in messages[1:]], ["recent user", "recent assistant"])

    def test_final_openai_messages_replaces_stale_summary_checkpoint(self) -> None:
        messages = _final_openai_messages(
            {
                "messages": [
                    HumanMessage(
                        content="[ScienceAgent summary checkpoint]\nstale",
                        name="summary",
                        additional_kwargs={
                            "hide_from_ui": True,
                            "science_agent_summary_checkpoint": True,
                        },
                    ),
                    HumanMessage(content="recent user"),
                ],
                "summary_text": "fresh summary",
            }
        )

        self.assertEqual(len(messages), 2)
        self.assertIn("fresh summary", messages[0]["content"])
        self.assertNotIn("stale", messages[0]["content"])
        self.assertEqual(messages[1]["content"], "recent user")

    def test_describe_skill_tool_reuses_engine_catalog_search(self) -> None:
        tool = _build_describe_skill_tool([
            SkillSpec(
                description="Workflow for selected progressive loading tests.",
                hash="b" * 64,
                id="selected-skill",
                resources=[SkillResourceSpec(hash="a" * 64, kind="reference", path="references/guide.md", size=24)],
                revision=3,
                version="1.0.0",
            ),
            SkillSpec(
                description="Unrelated workflow.",
                hash="c" * 64,
                id="other-skill",
                resources=[],
                revision=1,
                version="1.0.0",
            ),
        ])

        assert tool is not None
        content = tool.func("progressive")

        self.assertIn("## Skill: selected-skill", content)
        self.assertIn("Workflow for selected progressive loading tests.", content)
        self.assertIn('call read_skill with skillId="selected-skill"', content)
        self.assertIn("references/guide.md (reference, 24 bytes)", content)
        self.assertNotIn("## Skill: other-skill", content)

        selected = tool.func("select:other-skill")
        self.assertIn("## Skill: other-skill", selected)

if __name__ == "__main__":
    unittest.main()
