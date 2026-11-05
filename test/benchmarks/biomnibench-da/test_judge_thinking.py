# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import unittest

from judge import thinking_fields


class JudgeThinkingTests(unittest.TestCase):
    def test_low_effort_reaches_request_body(self):
        self.assertEqual(thinking_fields({"BIOMNI_JUDGE_THINKING_MODE": "enabled",
                                          "BIOMNI_JUDGE_THINKING_EFFORT": "low"}),
                         {"thinking": {"type": "enabled"}, "reasoning_effort": "low"})

    def test_unconfigured_and_disabled_keep_their_wire_contract(self):
        self.assertEqual(thinking_fields({}), {})
        self.assertEqual(thinking_fields({"BIOMNI_JUDGE_THINKING_MODE": "disabled"}),
                         {"thinking": {"type": "disabled"}})

    def test_invalid_or_silently_ignored_effort_fails_before_scoring(self):
        for env in ({"BIOMNI_JUDGE_THINKING_MODE": "none"},
                    {"BIOMNI_JUDGE_THINKING_MODE": "enabled", "BIOMNI_JUDGE_THINKING_EFFORT": "none"},
                    {"BIOMNI_JUDGE_THINKING_MODE": "disabled", "BIOMNI_JUDGE_THINKING_EFFORT": "low"},
                    {"BIOMNI_JUDGE_THINKING_EFFORT": "low"}):
            with self.subTest(env=env), self.assertRaises(ValueError):
                thinking_fields(env)
