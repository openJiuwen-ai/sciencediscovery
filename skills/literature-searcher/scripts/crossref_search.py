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

"""CrossRef literature search script.

Searches CrossRef API for academic papers matching given keywords.
Returns results as structured JSON written to a file in the team workspace.
Stdout emits a compact metadata JSON for the calling agent to decide
whether/what to read from the file.

API: configured CrossRef works endpoint (REST API)
API Key: Optional -- CROSSREF_MAILTO env var for polite pool (1000/min vs 50/min).
         Set to your email for rate limit increase.

Output mode (default — file intermediary pattern):
  Full JSON result → written to {output_dir}/artifacts/literature_search/results_crossref_{timestamp}.json
  Stdout            → metadata JSON: {file_path, file_size_bytes, result_count, database, query, api_call_verified}

Usage:
    python crossref_search.py "transformer attention" --rows 20
"""

import argparse
import os
import re
import sys
import time

import requests

from output_utils import handle_output
from external_urls import external_url, format_external_url
from query_preprocessor import (
    core_query,
    domain_defaults,
    filter_relevant_sources,
    query_variants,
)


CROSSREF_API_URL = external_url("data_sources.crossref.works_api")


def _merge_filters(*filters: str) -> str:
    parts = []
    for value in filters:
        if not value:
            continue
        for piece in value.split(","):
            piece = piece.strip()
            if piece and piece not in parts:
                parts.append(piece)
    return ",".join(parts)


def _request_crossref(keywords: str, rows: int, sort: str, filter_expr: str,
                      timeout: int, headers: dict, query_field: str) -> dict:
    params = {"rows": rows}
    if query_field == "title":
        params["query.title"] = keywords
    elif query_field == "container-title":
        params["query.container-title"] = keywords
    else:
        params["query.bibliographic"] = keywords

    sort_map = {
        "relevance": ("relevance", "asc"),
        "published": ("published", "desc"),
        "is-referenced-by-count": ("is-referenced-by-count", "desc"),
    }
    sortBy, sortOrder = sort_map.get(sort, ("relevance", "asc"))
    params["sort"] = sortBy
    params["order"] = sortOrder

    if filter_expr:
        params["filter"] = filter_expr

    for attempt in range(2):
        try:
            resp = requests.get(CROSSREF_API_URL, params=params,
                                headers=headers, timeout=timeout + (30 * attempt))

            if resp.status_code == 429:
                if attempt == 0:
                    wait = 60 if not headers.get("User-Agent") else 10
                    print(f"Rate limited by CrossRef API. Waiting {wait}s before retry...", file=sys.stderr)
                    time.sleep(wait)
                    continue
                else:
                    print("Rate limited again after retry. Skipping CrossRef.", file=sys.stderr)
                    return {"sources": [], "total_results": 0, "query": keywords,
                            "database": "crossref", "api_call_verified": False,
                            "error": "rate_limited_after_retry"}

            if resp.status_code != 200:
                print(f"CrossRef API returned status {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
                return {"sources": [], "total_results": 0, "query": keywords,
                        "database": "crossref", "api_call_verified": False,
                        "error": f"http_{resp.status_code}"}

            data = resp.json()
            items = data.get("message", {}).get("items", [])

            sources = []
            for item in items:
                title_list = item.get("title", [])
                title = title_list[0] if title_list else ""

                authors_list = []
                for a in item.get("author", []):
                    given = a.get("given", "")
                    family = a.get("family", "")
                    name = f"{given} {family}".strip() if given else family
                    if name:
                        authors_list.append(name)

                year = None
                published = item.get("published-print") or item.get("published-online") or {}
                date_parts = published.get("date-parts", [[]])
                if date_parts and date_parts[0]:
                    year = date_parts[0][0]

                venue = ""
                container = item.get("container-title", [])
                if container and len(container) > 0:
                    venue = container[0]

                doi = item.get("DOI", "")
                url = item.get("URL", "")
                if doi and not url:
                    url = format_external_url("data_sources.doi.canonical_template", doi=doi)

                raw_abstract = item.get("abstract") or ""
                abstract = raw_abstract.strip() if isinstance(raw_abstract, str) else ""
                if abstract.startswith("<jats:"):
                    abstract = re.sub(r"<[^>]+>", "", abstract).strip()
                abstract = abstract[:1000] if abstract else ""

                sources.append({
                    "title": title,
                    "authors": authors_list,
                    "year": year,
                    "venue": venue,
                    "doi": doi,
                    "url": url,
                    "abstract": abstract,
                    "source_database": "crossref",
                })

            total = data.get("message", {}).get("total-results", len(sources))

            return {
                "sources": sources,
                "total_results": total,
                "query": keywords,
                "database": "crossref",
                "api_call_verified": True,
                "query_field": query_field,
                "filter": filter_expr,
            }

        except requests.exceptions.Timeout:
            if attempt == 0:
                print("CrossRef API timeout. Retrying with longer timeout...", file=sys.stderr)
                continue
            else:
                print("CrossRef API timeout after retry.", file=sys.stderr)
                return {"sources": [], "total_results": 0, "query": keywords,
                        "database": "crossref", "api_call_verified": False,
                        "error": "timeout_after_retry"}
        except requests.exceptions.ConnectionError as e:
            if attempt == 0:
                print(f"Network error: {e}. Retrying...", file=sys.stderr)
                time.sleep(3)
                continue
            else:
                print(f"Network error after retry: {e}", file=sys.stderr)
                return {"sources": [], "total_results": 0, "query": keywords,
                        "database": "crossref", "api_call_verified": False,
                        "error": f"connection_error: {e}"}
        except Exception as e:
            print(f"CrossRef API error: {e}", file=sys.stderr)
            return {"sources": [], "total_results": 0, "query": keywords,
                    "database": "crossref", "api_call_verified": False,
                    "error": str(e)}

    return {"sources": [], "total_results": 0, "query": keywords,
            "database": "crossref", "api_call_verified": False,
            "error": "max_retries_exceeded"}


def search_crossref(keywords: str, rows: int = 20, sort: str = "relevance",
                     filter_expr: str = None, timeout: int = 30,
                     query_field: str = "smart", auto_variants: bool = True,
                     strict_relevance: bool = True, domain: str = None,
                     has_abstract: bool = True) -> dict:
    mailto = os.environ.get("CROSSREF_MAILTO", "")
    headers = {}
    if mailto:
        headers["User-Agent"] = f"LiteratureSearcher/{mailto}"

    default_filter = domain_defaults(domain).get("crossref_filter") if domain else "type:journal-article"
    if has_abstract:
        default_filter = _merge_filters(default_filter, "has-abstract:true")
    effective_filter = _merge_filters(default_filter, filter_expr)

    variants = [core_query(keywords)]
    if auto_variants:
        variants = query_variants(keywords, limit=4)

    fields = [query_field]
    if query_field == "smart":
        fields = ["title", "bibliographic"]

    merged_sources = []
    relaxed_candidates = []
    seen = set()
    attempted_queries = []
    last_error = None
    relevance_mode = "strict"

    for variant in variants:
        for field in fields:
            result = _request_crossref(variant, rows, sort, effective_filter, timeout,
                                       headers, field)
            attempted_queries.append({
                "query": variant,
                "query_field": field,
                "filter": effective_filter,
            })
            if result.get("error"):
                last_error = result.get("error")
                continue

            sources = result.get("sources", [])
            if strict_relevance:
                filtered = filter_relevant_sources(
                    sources,
                    keywords,
                    min_score=8,
                    require_all_groups=True,
                )
                if not filtered:
                    relaxed_candidates.extend(filter_relevant_sources(
                        sources,
                        keywords,
                        min_score=6,
                        require_all_groups=False,
                    ))
                sources = filtered

            for source in sources:
                key = source.get("doi") or source.get("url") or source.get("title")
                if key and key not in seen:
                    merged_sources.append(source)
                    seen.add(key)
                if len(merged_sources) >= rows:
                    break
            if len(merged_sources) >= rows:
                break
        if len(merged_sources) >= rows:
            break

    if strict_relevance and not merged_sources and relaxed_candidates:
        relevance_mode = "relaxed_fallback"
        for source in relaxed_candidates:
            key = source.get("doi") or source.get("url") or source.get("title")
            if key and key not in seen:
                merged_sources.append(source)
                seen.add(key)
            if len(merged_sources) >= rows:
                break

    return {
        "sources": merged_sources[:rows],
        "total_results": len(merged_sources[:rows]),
        "query": keywords,
        "database": "crossref",
        "api_call_verified": bool(merged_sources) or last_error is None,
        "polite_pool": bool(mailto),
        "sort": sort,
        "filter": effective_filter,
        "query_field": query_field,
        "relevance_mode": relevance_mode if strict_relevance else "disabled",
        "query_variants": attempted_queries,
        "error": None if merged_sources else last_error,
    }


def main():
    parser = argparse.ArgumentParser(description="Search CrossRef for academic papers")
    parser.add_argument("keywords", help="Core search keywords")
    parser.add_argument("--rows", type=int, default=20, help="Maximum number of results")
    parser.add_argument("--sort", default="relevance",
                        choices=["relevance", "published", "is-referenced-by-count"])
    parser.add_argument("--filter", default=None,
                        help="Filter expression (e.g., from-pub-date:2023,type:journal-article)")
    parser.add_argument("--domain", default=None,
                        help="Optional domain used to infer safe default filters.")
    parser.add_argument("--query-field", default="smart",
                        choices=["smart", "bibliographic", "title", "container-title"],
                        help="CrossRef query field. smart tries title first, then bibliographic.")
    parser.add_argument("--has-abstract", action="store_true",
                        help="Keep has-abstract:true in CrossRef filters (default behavior).")
    parser.add_argument("--allow-no-abstract", action="store_true",
                        help="Do not require has-abstract:true in CrossRef filters.")
    parser.add_argument("--no-auto-variants", action="store_true",
                        help="Disable automatic short query variants.")
    parser.add_argument("--no-strict-relevance", action="store_true",
                        help="Disable post-query relevance filtering.")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    parser.add_argument("--output", default=None,
                        help="Explicit output file path. If set, overrides auto-detection and writes to this path.")
    parser.add_argument("--output-dir", default=None,
                        help="Base directory for auto-generated output file. Defaults to JiuwenSwarm team-workspace auto-detection.")

    args = parser.parse_args()

    result = search_crossref(args.keywords, args.rows, args.sort, args.filter, args.timeout,
                             args.query_field, not args.no_auto_variants,
                             not args.no_strict_relevance, args.domain,
                             not args.allow_no_abstract)

    handle_output(result, args)


if __name__ == "__main__":
    main()
