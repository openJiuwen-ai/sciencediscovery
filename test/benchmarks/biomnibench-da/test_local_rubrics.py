# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import hashlib
import unittest
from unittest.mock import patch

import rubrics


class LocalRubricRegistryTests(unittest.TestCase):
    def test_da_13_3_local_variant_is_pinned_and_non_official(self):
        path = rubrics.local_rubric_path('da-13-3')
        self.assertIsNotNone(path)
        identity = rubrics.rubric_identity(path, 'da-13-3')
        self.assertEqual(identity['channel'], 'local-variant')
        self.assertEqual(identity['version'], 'local-rubric-v1')
        self.assertEqual(identity['clarifies_criteria'], ['4', '5'])
        data = path.read_bytes()
        expected = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
        self.assertEqual(identity['git_blob_oid'], expected)

    def test_local_bytes_do_not_satisfy_other_case(self):
        path = rubrics.local_rubric_path('da-13-3')
        with self.assertRaisesRegex(ValueError, 'Local rubric case mismatch'):
            rubrics.rubric_identity(path, 'da-14-1')

    def test_unregistered_case_has_no_local_path(self):
        self.assertIsNone(rubrics.local_rubric_path('da-14-1'))

    def test_local_pin_mismatch_is_hard_error(self):
        variant = dict(rubrics.local_variant_for('da-13-3'))
        variant['sha256'] = '0' * 64
        with patch.object(rubrics, '_load_local_registry', return_value={'variants': [variant]}):
            with self.assertRaisesRegex(ValueError, 'Local rubric pin mismatch'):
                rubrics.local_rubric_path('da-13-3')


if __name__ == '__main__':
    unittest.main()
