# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Command-level suite guard: empty discovery and skipped cases are not passes."""
import sys
import unittest

suite = unittest.defaultTestLoader.discover(sys.argv[1], pattern="test_*.py")
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.testsRun and result.wasSuccessful() and not result.skipped else 1)
