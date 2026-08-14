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

"""Literature source deduplication script.

Deduplicates sources across multiple database search results by:
1. DOI exact match
2. URL exact match
3. Title similarity (threshold configurable, default 0.85)

Produces a deduplicated JSON output file and optional deduplication report file.
Stdout emits a compact metadata JSON for the calling agent.

Output mode (file intermediary pattern):
  Full JSON result → written to --output file (compact JSON, no indent)
  Dedup report     → written to --report file (if specified)
  Stdout           → metadata JSON: {output_file, report_file, file_size_bytes, total_before_dedup, duplicates_removed, final_unique}

Usage:
    python deduplicate.py results_arxiv.json results_s2.json results_pubmed.json \
        --output deduplicated_results.json --report dedup_report.json

    # With auto-detection of team-workspace output directory:
    python deduplicate.py artifacts/literature_search/results_*.json \
        --output artifacts/literature_search/deduplicated_results.json \
        --report artifacts/literature_search/dedup_report.json

    # Or let deduplicate.py auto-detect paths (no --output/--report):
    python deduplicate.py artifacts/literature_search/results_*.json
"""

import argparse
import glob as glob_mod
import json
import os
import sys

from output_utils import get_output_dir, LITERATURE_SEARCH_SUBDIR
from external_urls import external_url_list


def resolve_input_files(raw_patterns: list) -> list:
    resolved = []
    for pattern in raw_patterns:
        expanded = glob_mod.glob(pattern)
        if expanded:
            resolved.extend(sorted(expanded))
        elif os.path.isfile(pattern):
            resolved.append(pattern)
        else:
            print(f"Warning: input pattern '{pattern}' matched no files", file=sys.stderr)
    return resolved


def normalize_doi(doi: str) -> str:
    if not doi:
        return ""
    doi = doi.strip().lower()
    for prefix in external_url_list("data_sources.doi.accepted_prefixes"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
            break
    return doi


def normalize_url(url: str) -> str:
    if not url:
        return ""
    url = url.strip().lower()
    if url.endswith("/"):
        url = url[:-1]
    return url


def normalize_title(title: str) -> str:
    return title.strip().lower().replace("\n", " ").replace("  ", " ")


def title_similarity(t1: str, t2: str) -> float:
    t1 = normalize_title(t1)
    t2 = normalize_title(t2)
    if not t1 or not t2:
        return 0.0
    if t1 == t2:
        return 1.0

    words1 = set(t1.split())
    words2 = set(t2.split())
    intersection = words1 & words2
    union = words1 | words2
    if not union:
        return 0.0
    return len(intersection) / len(union)


def metadata_richness(source: dict) -> int:
    score = 0
    if source.get("title"):
        score += 1
    if source.get("abstract"):
        score += 2
    if source.get("doi"):
        score += 1
    if source.get("authors") and len(source.get("authors", [])) > 0:
        score += 1
    if source.get("year"):
        score += 1
    if source.get("venue"):
        score += 1
    return score


def deduplicate(input_files: list, title_threshold: float = 0.85) -> tuple:
    all_sources = []
    for filepath in input_files:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            sources = data
        else:
            sources = data.get("sources", [])
        all_sources.extend(sources)

    seen_dois = {}
    seen_urls = {}
    seen_titles = {}
    unique_sources = []
    duplicates_removed = []
    duplicate_details = []

    for source in all_sources:
        doi = normalize_doi(source.get("doi", ""))
        url = normalize_url(source.get("url", ""))
        title = normalize_title(source.get("title", ""))
        db = source.get("source_database", "unknown")

        is_duplicate = False
        matched_existing_idx = -1
        match_reason = ""

        if doi and doi in seen_dois:
            is_duplicate = True
            matched_existing_idx = seen_dois[doi]
            match_reason = "DOI match"

        if not is_duplicate and url and url in seen_urls:
            is_duplicate = True
            matched_existing_idx = seen_urls[url]
            match_reason = "URL match"

        if not is_duplicate and title:
            for idx, existing_title in seen_titles.items():
                sim = title_similarity(title, existing_title)
                if sim > title_threshold:
                    is_duplicate = True
                    matched_existing_idx = idx
                    match_reason = f"Title similarity ({sim:.2f})"
                    break

        if is_duplicate and matched_existing_idx >= 0:
            existing = unique_sources[matched_existing_idx]
            existing_db = existing.get("source_database", "unknown")
            duplicate_details.append({
                "title": source.get("title", ""),
                "databases": [existing_db, db],
                "match_reason": match_reason,
                "kept_source": existing_db if metadata_richness(existing) >= metadata_richness(source) else db,
            })

            if metadata_richness(source) > metadata_richness(existing):
                existing_url = normalize_url(existing.get("url", ""))
                if existing_url and existing_url != url and existing_url in seen_urls:
                    del seen_urls[existing_url]
                unique_sources[matched_existing_idx] = source
                if doi:
                    seen_dois[doi] = matched_existing_idx
                if url:
                    seen_urls[url] = matched_existing_idx
                seen_titles[matched_existing_idx] = title

            duplicates_removed.append(source)
        else:
            idx = len(unique_sources)
            unique_sources.append(source)
            if doi:
                seen_dois[doi] = idx
            if url:
                seen_urls[url] = idx
            seen_titles[idx] = title

    report = {
        "total_before_dedup": len(all_sources),
        "duplicates_removed": len(duplicates_removed),
        "final_unique": len(unique_sources),
        "dedup_methods": ["DOI exact match", "URL exact match", f"Title similarity > {title_threshold}"],
        "duplicate_details": duplicate_details,
        "input_files": input_files,
    }

    return unique_sources, report


def main():
    base_dir = get_output_dir()
    default_output_dir = os.path.join(base_dir, LITERATURE_SEARCH_SUBDIR)

    parser = argparse.ArgumentParser(description="Deduplicate literature search results across databases")
    parser.add_argument("input_files", nargs="+",
                        help="JSON files from search scripts to deduplicate. Supports glob patterns (e.g., 'artifacts/literature_search/results_*.json')")
    parser.add_argument("--output", default=None,
                        help=f"Deduplicated output JSON file path. Defaults to {default_output_dir}/deduplicated_results.json")
    parser.add_argument("--report", default=None,
                        help=f"Deduplication report JSON file path. Defaults to {default_output_dir}/dedup_report.json if --output is auto-detected")
    parser.add_argument("--title-similarity-threshold", type=float, default=0.85,
                        help="Title similarity threshold for near-duplicate detection (default: 0.85)")

    args = parser.parse_args()

    resolved_inputs = resolve_input_files(args.input_files)
    if not resolved_inputs:
        print("Error: no input files found after resolving glob patterns", file=sys.stderr)
        sys.exit(1)

    for filepath in resolved_inputs:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                json.load(f)
        except Exception as e:
            print(f"Error reading {filepath}: {e}", file=sys.stderr)
            sys.exit(1)

    unique_sources, report = deduplicate(resolved_inputs, args.title_similarity_threshold)

    result = {
        "sources": unique_sources,
        "total_results": len(unique_sources),
        "dedup_report": report,
    }

    if args.output:
        output_path = args.output
    else:
        os.makedirs(default_output_dir, exist_ok=True)
        output_path = os.path.join(default_output_dir, "deduplicated_results.json")

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))

    output_size = os.path.getsize(output_path)

    report_path = None
    if args.report:
        report_path = args.report
    elif not args.output:
        report_path = os.path.join(default_output_dir, "dedup_report.json")

    if report_path:
        os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, separators=(",", ":"))

    metadata = {
        "output_file": output_path,
        "output_size_bytes": output_size,
        "output_size_human": f"{output_size / 1024:.1f}KB",
        "report_file": report_path,
        "total_before_dedup": report["total_before_dedup"],
        "duplicates_removed": report["duplicates_removed"],
        "final_unique": report["final_unique"],
        "input_files": resolved_inputs,
    }

    print(json.dumps(metadata, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
