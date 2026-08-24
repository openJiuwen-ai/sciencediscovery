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

from sciencediscovery_gateway.external_urls import external_url, external_url_list, format_external_url


class ExternalUrlsTests(unittest.TestCase):
    def test_defaults_and_templates_match_existing_behavior(self) -> None:
        self.assertEqual(external_url("package_indexes.pypi_simple"), "https://pypi.org/simple")
        self.assertEqual(
            format_external_url("data_sources.ncbi.pubmed_article_template", pmid="12345"),
            "https://pubmed.ncbi.nlm.nih.gov/12345/",
        )
        self.assertEqual(
            external_url_list("web.jina_endpoints"),
            ("https://r.jinaai.cn", "https://r.jina.ai"),
        )

    def test_missing_keys_and_template_arguments_fail_clearly(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "missing required key"):
            external_url("data_sources.missing")
        with self.assertRaisesRegex(RuntimeError, "requires parameter: identifier"):
            format_external_url("data_sources.arxiv.article_template")


if __name__ == "__main__":
    unittest.main()
