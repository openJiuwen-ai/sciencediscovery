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

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from paper_worker import extract_pdf  # noqa: E402


class PaperWorkerTest(unittest.TestCase):
    def test_extracts_text_table_figure_and_page_previews(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "paper.pdf"
            figure = Image.new("RGB", (80, 50), (30, 110, 180))
            pdf = canvas.Canvas(str(source), pagesize=(400, 500))
            pdf.drawString(40, 460, "A machine-readable scientific paper")
            for x in (40, 180, 320):
                pdf.line(x, 300, x, 390)
            for y in (300, 330, 360, 390):
                pdf.line(40, y, 320, y)
            pdf.drawString(55, 370, "Group")
            pdf.drawString(195, 370, "Mean")
            pdf.drawString(55, 340, "Control")
            pdf.drawString(195, 340, "1.2")
            pdf.drawString(55, 310, "Treatment")
            pdf.drawString(195, 310, "2.4")
            pdf.drawImage(ImageReader(figure), 40, 170, width=160, height=100)
            pdf.showPage()
            pdf.drawString(40, 460, "Second page with embedded text")
            pdf.save()

            output = root / "output"
            manifest = extract_pdf(source, output)

            self.assertEqual(manifest["pageCount"], 2)
            self.assertGreater(manifest["textCharacters"], 40)
            self.assertGreaterEqual(len(manifest["tables"]), 1)
            self.assertGreaterEqual(len(manifest["images"]), 1)
            self.assertTrue((output / "fulltext.md").read_text(encoding="utf-8").startswith("# Extracted PDF text"))
            self.assertTrue((output / manifest["tables"][0]["csvPath"]).is_file())
            self.assertTrue((output / manifest["images"][0]["path"]).is_file())
            self.assertTrue((output / "pages/page-0001.png").is_file())
            persisted = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["inputSha256"], manifest["inputSha256"])

    def test_rejects_non_pdf_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "not.pdf"
            source.write_text("not a PDF", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "PDF signature"):
                extract_pdf(source, root / "output")


if __name__ == "__main__":
    unittest.main()
