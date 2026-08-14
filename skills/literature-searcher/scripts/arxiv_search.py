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

"""arXiv literature search script.

Searches arXiv API for academic papers matching given keywords.
Returns results as structured JSON written to a file in the team workspace.
Stdout emits a compact metadata JSON for the calling agent to decide
whether/what to read from the file.

API: configured arXiv Atom endpoint (no API key required)
Rate limit: be respectful (~1 request/3s)

Output mode (default — file intermediary pattern):
  Full JSON result → written to {output_dir}/artifacts/literature_search/results_arxiv_{timestamp}.json
  Stdout            → metadata JSON: {file_path, file_size_bytes, result_count, database, query, api_call_verified}

Usage:
    python arxiv_search.py "transformer attention" --max-results 20 --category cs.CL --sort-by relevance
"""

import argparse
import os
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

from output_utils import handle_output
from external_urls import external_url
from query_preprocessor import (
    core_query,
    domain_defaults,
    filter_relevant_sources,
    query_variants,
)
import ssl
import certifi

ssl_context = ssl.create_default_context(cafile=certifi.where())
# 然后在 urlopen 时传入: urllib.request.urlopen(req, context=ssl_context, timeout=...)


ARXIV_API_URL = external_url("data_sources.arxiv.api_query")


def _field_expr(field: str, value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if " " in value:
        return f'{field}:"{value}"'
    return f"{field}:{value}"


def _title_or_abstract(value: str) -> str:
    return f'({_field_expr("ti", value)} OR {_field_expr("abs", value)})'


def build_query(keywords: str, category: str = None, search_field: str = "smart",
                raw_query: bool = False) -> str:
    if raw_query:
        search_query = keywords
    elif search_field == "all":
        search_query = f"all:{keywords}"
    elif search_field == "title":
        search_query = _field_expr("ti", keywords)
    elif search_field == "abstract":
        search_query = _field_expr("abs", keywords)
    elif search_field == "title-abstract":
        search_query = _title_or_abstract(keywords)
    else:
        normalized = core_query(keywords)
        lowered = normalized.lower()
        if "graph neural network" in lowered and "molecular" in lowered:
            search_query = (
                f'{_title_or_abstract("graph neural network")} AND '
                f'({_field_expr("ti", "molecular")} OR {_field_expr("abs", "molecular")})'
            )
        elif "message passing neural network" in lowered and "molecular" in lowered:
            search_query = (
                f'{_title_or_abstract("message passing neural network")} AND '
                f'({_field_expr("ti", "molecular")} OR {_field_expr("abs", "molecular")})'
            )
        else:
            search_query = _title_or_abstract(normalized)

    parts = [search_query]
    if category:
        parts.append(f"cat:{category}")
    return " AND ".join(parts) if len(parts) > 1 else parts[0]


def build_search_url(keywords: str, max_results: int, category: str = None,
                     sort_by: str = "relevance", start_date: str = None,
                     end_date: str = None, search_field: str = "smart",
                     raw_query: bool = False) -> str:
    search_query = build_query(keywords, category, search_field, raw_query)

    if start_date or end_date:
        today = datetime.now(timezone.utc)
        default_end = (today + timedelta(days=1)).strftime("%Y%m%d")
        start_dt = (start_date.replace("-", "") if start_date else "00000000") + "000000"
        end_dt = (end_date.replace("-", "") if end_date else default_end) + "235959"
        search_query += f" AND submittedDate:[{start_dt} TO {end_dt}]"

    sort_map = {
        "relevance": ("relevance", "ascending"),
        "submittedDate": ("submittedDate", "descending"),
        "lastUpdatedDate": ("lastUpdatedDate", "descending"),
    }
    sortBy, sortOrder = sort_map.get(sort_by, ("relevance", "ascending"))

    params = urllib.parse.urlencode({
        "search_query": search_query,
        "max_results": max_results,
        "sortBy": sortBy,
        "sortOrder": sortOrder,
    })

    return f"{ARXIV_API_URL}?{params}"


def parse_arxiv_xml(xml_text: str) -> list:
    root = ET.fromstring(xml_text)
    ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

    sources = []
    for entry in root.findall("atom:entry", ns):
        title = entry.findtext("atom:title", "", ns).strip().replace("\n", " ")
        authors = [a.findtext("atom:name", "", ns) for a in entry.findall("atom:author", ns)]
        abstract = entry.findtext("atom:summary", "", ns).strip().replace("\n", " ")
        url = entry.findtext("atom:id", "", ns).strip()
        published = entry.findtext("atom:published", "", ns).strip()
        year = int(published[:4]) if published else None

        doi_elem = entry.find("arxiv:doi", ns)
        doi = doi_elem.text.strip() if doi_elem is not None else ""

        category_elem = entry.find("atom:category", ns)
        primary_category = category_elem.get("term", "") if category_elem is not None else ""

        venue = "arXiv preprint"
        journal_ref = entry.find("arxiv:journal_ref", ns)
        if journal_ref is not None:
            venue = journal_ref.text.strip()

        sources.append({
            "title": title,
            "authors": authors,
            "year": year,
            "venue": venue,
            "doi": doi,
            "url": url,
            "abstract": abstract[:1000] if abstract else "",
            "source_database": "arxiv",
            "primary_category": primary_category,
        })

    return sources


def search_arxiv(keywords: str, max_results: int = 20, category: str = None,
                 sort_by: str = "relevance", start_date: str = None,
                 end_date: str = None, timeout: int = 30,
                 search_field: str = "smart", raw_query: bool = False,
                 auto_variants: bool = True, strict_relevance: bool = True,
                 original_topic: str = None) -> dict:
    original_topic = original_topic or keywords
    variants = [keywords]
    if auto_variants and not raw_query:
        variants = query_variants(keywords, limit=3)

    merged_sources = []
    seen_urls = set()
    attempted_queries = []
    last_error = None

    for variant in variants:
        url = build_search_url(variant, max_results, category, sort_by, start_date, end_date,
                               search_field, raw_query)
        attempted_queries.append({
            "query": variant,
            "search_query": build_query(variant, category, search_field, raw_query),
        })

        result = _search_arxiv_once(variant, max_results, category, sort_by, start_date,
                                    end_date, timeout, url)
        if result.get("error"):
            last_error = result.get("error")
        sources = result.get("sources", [])
        if strict_relevance and not raw_query:
            filtered = filter_relevant_sources(sources, original_topic, min_score=6)
            # Keep the raw API result when filtering would erase a non-empty generic search.
            # For cross-domain topics, however, filtering is what prevents noisy handoff.
            sources = filtered if filtered or len(query_variants(original_topic, limit=1)[0].split()) >= 3 else sources

        for source in sources:
            key = source.get("url") or source.get("doi") or source.get("title")
            if key and key not in seen_urls:
                merged_sources.append(source)
                seen_urls.add(key)
            if len(merged_sources) >= max_results:
                break
        if len(merged_sources) >= max_results:
            break

    return {
        "sources": merged_sources[:max_results],
        "total_results": len(merged_sources[:max_results]),
        "query": keywords,
        "database": "arxiv",
        "api_call_verified": bool(merged_sources) or last_error is None,
        "category_filter": category,
        "sort_by": sort_by,
        "date_range": f"{start_date or 'none'}-{end_date or 'none'}",
        "search_field": search_field,
        "raw_query": raw_query,
        "query_variants": attempted_queries,
        "error": None if merged_sources else last_error,
    }


def _search_arxiv_once(keywords: str, max_results: int, category: str,
                       sort_by: str, start_date: str, end_date: str,
                       timeout: int, url: str) -> dict:

    for attempt in range(2):
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, context=ssl_context, timeout=timeout + (30 * attempt)) as resp:
                xml_text = resp.read().decode("utf-8")
            sources = parse_arxiv_xml(xml_text)
            return {
                "sources": sources,
                "total_results": len(sources),
                "query": keywords,
                "database": "arxiv",
                "api_call_verified": True,
                "category_filter": category,
                "sort_by": sort_by,
                "date_range": f"{start_date or 'none'}-{end_date or 'none'}",
                "api_url": url,
            }
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if attempt == 0:
                    print(f"Rate limited by arXiv API. Waiting 60s before retry...", file=sys.stderr)
                    time.sleep(60)
                    continue
                else:
                    print(f"Rate limited again after retry. Skipping arXiv.", file=sys.stderr)
                    return {"sources": [], "total_results": 0, "query": keywords, "database": "arxiv",
                            "api_call_verified": False, "error": "rate_limited_after_retry"}
        except Exception as e:
            if attempt == 0:
                print(f"arXiv API error: {e}. Retrying with longer timeout...", file=sys.stderr)
                time.sleep(3)
                continue
            else:
                print(f"arXiv API failed after retry: {e}", file=sys.stderr)
                return {"sources": [], "total_results": 0, "query": keywords, "database": "arxiv",
                        "api_call_verified": False, "error": str(e)}

    return {"sources": [], "total_results": 0, "query": keywords, "database": "arxiv",
            "api_call_verified": False, "error": "max_retries_exceeded"}


def main():
    parser = argparse.ArgumentParser(description="Search arXiv for academic papers")
    parser.add_argument("keywords", help="Core search keywords (2-3 words recommended)")
    parser.add_argument("--max-results", type=int, default=20, help="Maximum number of results")
    parser.add_argument("--category", default=None, help="arXiv category filter (e.g., cs.CL, q-bio.*)")
    parser.add_argument("--domain", default=None,
                        help="Optional domain used to infer category when --category is omitted")
    parser.add_argument("--sort-by", default="relevance", choices=["relevance", "submittedDate", "lastUpdatedDate"])
    parser.add_argument("--search-field", default="smart",
                        choices=["smart", "all", "title", "abstract", "title-abstract"],
                        help="Search scope. smart uses title/abstract field queries and topic-aware constraints.")
    parser.add_argument("--raw-query", action="store_true",
                        help="Treat keywords as a complete arXiv search_query expression.")
    parser.add_argument("--no-auto-variants", action="store_true",
                        help="Disable automatic query variants.")
    parser.add_argument("--no-strict-relevance", action="store_true",
                        help="Disable post-query relevance filtering.")
    parser.add_argument("--start-date", default=None, help="Filter papers submitted after this date (YYYY-MM-DD)")
    parser.add_argument("--end-date", default=None, help="Filter papers submitted before this date (YYYY-MM-DD)")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    parser.add_argument("--output", default=None,
                        help="Explicit output file path. If set, overrides auto-detection and writes to this path.")
    parser.add_argument("--output-dir", default=None,
                        help="Base directory for auto-generated output file. Defaults to JiuwenSwarm team-workspace auto-detection.")

    args = parser.parse_args()
    category = args.category
    if not category and args.domain:
        category = domain_defaults(args.domain).get("arxiv_category")

    result = search_arxiv(args.keywords, args.max_results, category,
                          args.sort_by, args.start_date, args.end_date, args.timeout,
                          args.search_field, args.raw_query,
                          not args.no_auto_variants, not args.no_strict_relevance)

    handle_output(result, args)


if __name__ == "__main__":
    main()
