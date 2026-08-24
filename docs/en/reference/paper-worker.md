# PDF Extraction: `services/paper`

This isolated, non-resident Python worker is launched once per request by the control API and converts a PDF into bounded Markdown, tables, figures, and page previews. User-visible limits are listed in [Runtime behavior](runtime-behavior.md#paper-reader-limits).

## 1. Invocation protocol

`papers.ts` starts it with `execFile`:

```text
<python> services/paper/paper_worker.py <input-pdf> <output-directory>
```

- Python defaults to `.sciencediscovery-data/envs/paper/bin/python` and can be overridden by `SCIENCE_AGENT_PAPER_PYTHON_PATH`; the worker path is `SCIENCE_AGENT_PAPER_WORKER_PATH`.
- The worker writes a `PaperExtractionManifest` JSON object to stdout. The API limits stdout to 10 MiB and each invocation to 120 seconds.
- The API records failure/cancellation in `.sciencediscovery-data/artifact-extraction-jobs/` as `CANCELLED` or `NORMALIZATION_FAILED`; it does not retry automatically.

## 2. Extraction pipeline

`paper_worker.py` uses pdfplumber:

1. Validate size at most `MAX_PDF_BYTES` (50 MiB), `%PDF-` signature, empty output directory, and at most `MAX_PAGES` (200).
2. Run `extract_text(layout=True)` per page, cap the total at `MAX_TEXT_CHARACTERS` (20 million), and write `fulltext.md` with `## Page N` sections.
3. Run `find_tables()`, discard one-row/one-column tables, and emit CSV plus cropped PNG for up to `MAX_TABLES` (256).
4. Deduplicate `page.images` by bounding box, ignore images below 8×8 pt, and render up to `MAX_FIGURES` (128) PNG files.
5. Render the first `MAX_PAGE_PREVIEWS` (24) pages as PNG. All rendering uses 120 DPI.
6. Write a manifest with the input SHA256, page/character counts, per-page `needsVision` when embedded text has fewer than 80 characters, all limits, and warnings.

Output under the session workspace `papers/<paper-id>/analysis/`:

```text
manifest.json  fulltext.md  tables.json
pages/page-0001.png …  tables/table-0001-p3.{csv,png} …  images/figure-0001-p2.png …
```

## 3. Vision analysis (API side)

`POST /api/sessions/:id/papers/:paperId/vision` triggers it manually. Candidate order is `needsVision` page previews, figures, then all page previews; at most `MAX_VISION_IMAGES` (4) are used. Each image is at most 5 MiB, all images at most 12 MiB, the response at most 2 MiB, and the timeout 90 seconds. The control API posts base64 data URLs to the vision model's `chat/completions`, writes `papers/<id>/vision/<run-id>.md`, stores request/response in CAS, and records model usage.

## 4. Tests

`pnpm paper:setup` creates the uv-locked environment and `pnpm paper:test` runs `services/paper/tests/`; both are included in `pnpm check`.

## Related documentation

- [Science connectors](../explanation/science-connectors.md)
- [Control plane](../explanation/control-plane.md)
