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

from sciencediscovery_gateway.uniprot_mcp import _parse_tsv, prepare_sequence


class UniProtMcpTests(unittest.IsolatedAsyncioTestCase):
    def test_tsv_fixture_preserves_canonical_identity_and_citation(self) -> None:
        records = _parse_tsv(
            "Entry\tEntry Name\tReviewed\tProtein names\tGene Names\tOrganism\tLength\n"
            "P04637\tP53_HUMAN\treviewed\tCellular tumor antigen p53\tTP53\tHomo sapiens\t393\n"
        )
        self.assertEqual(records[0]["identifier"], "P04637")
        self.assertEqual(records[0]["source"], "uniprot")
        self.assertEqual(records[0]["primaryCitation"]["source"], "uniprot")
        self.assertEqual(records[0]["structuredData"]["reviewed"], "reviewed")

    async def test_sequence_candidate_is_explicit_and_provider_allowlisted(self) -> None:
        result = await prepare_sequence("p04637", "fasta")
        self.assertEqual(result["sourceId"], "uniprot")
        self.assertEqual(result["toolId"], "prepare_sequence")
        self.assertEqual(result["artifacts"][0]["sourceRecordId"], "P04637")
        self.assertTrue(
            result["artifacts"][0]["sourceUrl"].startswith(
                "https://rest.uniprot.org/uniprotkb/"
            )
        )

    async def test_sequence_rejects_invalid_accession_and_format(self) -> None:
        with self.assertRaises(ValueError):
            await prepare_sequence("../bad", "fasta")
        with self.assertRaises(ValueError):
            await prepare_sequence("P04637", "exe")


if __name__ == "__main__":
    unittest.main()
