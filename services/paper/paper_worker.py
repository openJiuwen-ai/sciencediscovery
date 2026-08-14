#!/usr/bin/env python3
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

"""Extract bounded, deterministic text, tables, and visual assets from a PDF."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pdfplumber


MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PAGES = 200
MAX_TEXT_CHARACTERS = 20_000_000
MAX_TABLES = 256
MAX_FIGURES = 128
MAX_PAGE_PREVIEWS = 24
RENDER_RESOLUTION = 120


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def bounded_bbox(page: Any, bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float] | None:
    x0, top, x1, bottom = bbox
    x0 = max(0.0, min(float(page.width), float(x0)))
    x1 = max(0.0, min(float(page.width), float(x1)))
    top = max(0.0, min(float(page.height), float(top)))
    bottom = max(0.0, min(float(page.height), float(bottom)))
    if x1 - x0 < 8 or bottom - top < 8:
        return None
    return (x0, top, x1, bottom)


def render(page: Any, path: Path, bbox: tuple[float, float, float, float] | None = None) -> None:
    target = page.crop(bbox, strict=False) if bbox else page
    image = target.to_image(resolution=RENDER_RESOLUTION, antialias=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


def extract_pdf(input_pdf: Path, output_dir: Path) -> dict[str, Any]:
    pdf_bytes = input_pdf.read_bytes()
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ValueError(f"PDF exceeds the {MAX_PDF_BYTES} byte limit")
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("Input does not have a PDF signature")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError("Output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)

    pages_manifest: list[dict[str, Any]] = []
    tables_manifest: list[dict[str, Any]] = []
    images_manifest: list[dict[str, Any]] = []
    warnings: list[str] = []
    markdown: list[str] = []
    text_characters = 0

    with pdfplumber.open(input_pdf) as pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise ValueError(f"PDF has {len(pdf.pages)} pages; the limit is {MAX_PAGES}")
        for page_number, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(layout=True, x_tolerance=2, y_tolerance=3) or ""
            text_characters += len(text)
            if text_characters > MAX_TEXT_CHARACTERS:
                raise ValueError(f"Extracted text exceeds {MAX_TEXT_CHARACTERS} characters")
            markdown.extend([f"## Page {page_number}", "", text.strip() or "_[No embedded text; use an extracted page image with a vision model.]_", ""])
            page_entry: dict[str, Any] = {
                "page": page_number,
                "textCharacters": len(text.strip()),
                "needsVision": len(text.strip()) < 80,
            }

            if page_number <= MAX_PAGE_PREVIEWS:
                preview_path = output_dir / "pages" / f"page-{page_number:04d}.png"
                render(page, preview_path)
                page_entry["previewPath"] = relative(preview_path, output_dir)
            pages_manifest.append(page_entry)

            if len(tables_manifest) < MAX_TABLES:
                for table_index, table in enumerate(page.find_tables(), start=1):
                    if len(tables_manifest) >= MAX_TABLES:
                        break
                    rows = [[clean_cell(cell) for cell in row] for row in table.extract()]
                    rows = [row for row in rows if any(row)]
                    if len(rows) < 2 or max((len(row) for row in rows), default=0) < 2:
                        continue
                    ordinal = len(tables_manifest) + 1
                    csv_path = output_dir / "tables" / f"table-{ordinal:04d}-p{page_number}.csv"
                    csv_path.parent.mkdir(parents=True, exist_ok=True)
                    with csv_path.open("w", encoding="utf-8", newline="") as handle:
                        csv.writer(handle).writerows(rows)
                    preview_path = output_dir / "tables" / f"table-{ordinal:04d}-p{page_number}.png"
                    bbox = bounded_bbox(page, tuple(table.bbox))
                    if bbox:
                        render(page, preview_path, bbox)
                    tables_manifest.append({
                        "bbox": [round(value, 2) for value in table.bbox],
                        "columns": max(len(row) for row in rows),
                        "csvPath": relative(csv_path, output_dir),
                        "page": page_number,
                        "previewPath": relative(preview_path, output_dir) if preview_path.exists() else None,
                        "rows": len(rows),
                    })

            seen_boxes: set[tuple[int, int, int, int]] = set()
            for image in page.images:
                if len(images_manifest) >= MAX_FIGURES:
                    break
                raw_bbox = (image.get("x0", 0), image.get("top", 0), image.get("x1", 0), image.get("bottom", 0))
                bbox = bounded_bbox(page, raw_bbox)
                if not bbox:
                    continue
                key = tuple(round(value) for value in bbox)
                if key in seen_boxes:
                    continue
                seen_boxes.add(key)
                ordinal = len(images_manifest) + 1
                path = output_dir / "images" / f"figure-{ordinal:04d}-p{page_number}.png"
                render(page, path, bbox)
                images_manifest.append({
                    "bbox": [round(value, 2) for value in bbox],
                    "height": round(bbox[3] - bbox[1], 2),
                    "page": page_number,
                    "path": relative(path, output_dir),
                    "width": round(bbox[2] - bbox[0], 2),
                })

    if len(pages_manifest) > MAX_PAGE_PREVIEWS:
        warnings.append(f"Rendered only the first {MAX_PAGE_PREVIEWS} page previews")
    if len(tables_manifest) >= MAX_TABLES:
        warnings.append(f"Stopped after {MAX_TABLES} tables")
    if len(images_manifest) >= MAX_FIGURES:
        warnings.append(f"Stopped after {MAX_FIGURES} figures")
    if any(page["needsVision"] for page in pages_manifest):
        warnings.append("Some pages contain little embedded text; optional vision analysis is recommended")

    fulltext_path = output_dir / "fulltext.md"
    fulltext_path.write_text("# Extracted PDF text\n\n" + "\n".join(markdown).strip() + "\n", encoding="utf-8")
    tables_path = output_dir / "tables.json"
    tables_path.write_text(json.dumps(tables_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "images": images_manifest,
        "inputSha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "limits": {
            "maxFigures": MAX_FIGURES,
            "maxPagePreviews": MAX_PAGE_PREVIEWS,
            "maxPages": MAX_PAGES,
            "maxPdfBytes": MAX_PDF_BYTES,
            "maxTables": MAX_TABLES,
        },
        "pageCount": len(pages_manifest),
        "pages": pages_manifest,
        "parser": f"pdfplumber-{pdfplumber.__version__}",
        "pdfBytes": len(pdf_bytes),
        "schemaVersion": 1,
        "tables": tables_manifest,
        "textCharacters": text_characters,
        "textPath": relative(fulltext_path, output_dir),
        "warnings": warnings,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    manifest = extract_pdf(args.input_pdf.resolve(), args.output_dir.resolve())
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
