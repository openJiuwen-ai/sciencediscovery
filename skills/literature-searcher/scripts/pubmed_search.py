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

"""PubMed literature search script via NCBI E-utilities.

Searches PubMed for biomedical/life science papers matching given keywords.
Returns results as structured JSON written to a file in the team workspace.
Stdout emits a compact metadata JSON for the calling agent to decide
whether/what to read from the file.

API: configured NCBI E-utilities endpoints
API Key: OPTIONAL — set NCBI_API_KEY for higher rate limit (10 req/s vs 3 req/s).
         The configured account-help URL describes how to obtain one.

Output mode (default — file intermediary pattern):
  Full JSON result → written to {output_dir}/artifacts/literature_search/results_pubmed_{timestamp}.json
  Stdout            → metadata JSON: {file_path, file_size_bytes, result_count, database, query, api_call_verified}

Usage:
    python pubmed_search.py "artificial intelligence diagnosis" --max-results 20 --sort-by relevance
"""

import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET

import requests

from output_utils import handle_output
from external_urls import external_url, format_external_url
from query_preprocessor import (
    domain_defaults,
    expand_acronyms,
    filter_relevant_sources,
    query_variants,
)


ESEARCH_URL = external_url("data_sources.ncbi.eutils_esearch")
EFETCH_URL = external_url("data_sources.ncbi.eutils_efetch")
NCBI_ACCOUNTS_URL = external_url("data_sources.ncbi.accounts_help")


def format_pubmed_date(date_text: str) -> str:
    """Convert ISO dates to PubMed PDAT dates.

    PubMed accepts dates like YYYY/MM/DD for [PDAT]. Passing YYYY-MM-DD can
    silently collapse otherwise valid queries to zero results.
    """
    if not date_text:
        return ""
    return date_text.strip().replace("-", "/")


def get_api_key() -> str:
    key = os.environ.get("NCBI_API_KEY", "")
    if not key:
        print("Note: NCBI_API_KEY not set — running at the 3 req/s rate limit.", file=sys.stderr)
        print(f"      Set NCBI_API_KEY for 10 req/s. See {NCBI_ACCOUNTS_URL}", file=sys.stderr)
    return key


def build_pubmed_term(keywords: str, mesh_term: str = None, title_abstract: bool = False) -> str:
    keywords = expand_acronyms(keywords)
    if title_abstract:
        lowered = keywords.lower()
        if "graph neural network" in lowered and "molecular" in lowered:
            term = (
                '("graph neural network"[Title/Abstract] OR "graph neural networks"[Title/Abstract] '
                'OR "message passing neural network"[Title/Abstract]) AND '
                '(molecular[Title/Abstract] OR molecule[Title/Abstract] OR molecules[Title/Abstract])'
            )
        else:
            term = f'"{keywords}"[Title/Abstract]' if " " in keywords else f"{keywords}[Title/Abstract]"
    else:
        term = keywords

    if mesh_term:
        term = f"({term}) AND {mesh_term}[MeSH Terms]"
    return term


def esearch(keywords: str, max_results: int, sort: str, start_date: str,
            end_date: str, mesh_term: str, api_key: str, timeout: int,
            title_abstract: bool = False):
    params = {
        "db": "pubmed",
        "term": build_pubmed_term(keywords, mesh_term, title_abstract),
        "retmax": max_results,
        "sort": sort,
        "usehistory": "y",
    }
    if api_key:
        params["api_key"] = api_key

    if start_date:
        params["datetype"] = "pdat"
        params["mindate"] = format_pubmed_date(start_date)
    if end_date:
        params["datetype"] = "pdat"
        params["maxdate"] = format_pubmed_date(end_date)

    for attempt in range(2):
        try:
            resp = requests.get(ESEARCH_URL, params=params, timeout=timeout + (30 * attempt))

            if resp.status_code == 429:
                if attempt == 0:
                    print("Rate limited by NCBI E-utilities. Waiting 60s before retry...", file=sys.stderr)
                    time.sleep(60)
                    continue
                else:
                    print("Rate limited again after retry. Skipping PubMed.", file=sys.stderr)
                    return None

            if resp.status_code != 200:
                print(f"NCBI E-utilities returned status {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
                return None

            root = ET.fromstring(resp.text)
            id_list = [elem.text for elem in root.findall("IdList/Id")]
            return id_list

        except requests.exceptions.Timeout:
            if attempt == 0:
                print("NCBI E-utilities timeout. Retrying...", file=sys.stderr)
                continue
            else:
                print("NCBI E-utilities timeout after retry.", file=sys.stderr)
                return None
        except Exception as e:
            print(f"NCBI E-search error: {e}", file=sys.stderr)
            return None


def efetch(pmids: list, api_key: str, timeout: int) -> list:
    if not pmids:
        return []

    params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "rettype": "xml",
        "retmode": "xml",
    }
    if api_key:
        params["api_key"] = api_key

    for attempt in range(2):
        try:
            resp = requests.get(EFETCH_URL, params=params, timeout=timeout + (30 * attempt))

            if resp.status_code != 200:
                print(f"NCBI efetch returned status {resp.status_code}", file=sys.stderr)
                return []

            root = ET.fromstring(resp.text)
            sources = []

            for article in root.findall(".//PubmedArticle"):
                medline = article.find("MedlineCitation")
                art = medline.find("Article") if medline is not None else None
                if art is None:
                    continue

                title = art.findtext("ArticleTitle", "").strip()

                authors = []
                author_list = art.find("AuthorList")
                if author_list is not None:
                    for auth in author_list.findall("Author"):
                        last = auth.findtext("LastName", "")
                        fore = auth.findtext("ForeName", "")
                        name = f"{last} {fore}".strip() if fore else last
                        if name:
                            authors.append(name)

                journal = art.find("Journal")
                venue = ""
                if journal is not None:
                    jtitle = journal.findtext("Title", "")
                    venue = jtitle.strip()

                year = None
                pub_date = art.find("Journal/JournalIssue/PubDate")
                if pub_date is not None:
                    y = pub_date.findtext("Year", "")
                    if y:
                        year = int(y)
                    elif pub_date.findtext("MedlineDate", ""):
                        md = pub_date.findtext("MedlineDate", "")
                        try:
                            year = int(md[:4])
                        except ValueError:
                            pass

                abstract_parts = []
                abstract_el = art.find("Abstract")
                if abstract_el is not None:
                    for abs_text in abstract_el.findall("AbstractText"):
                        label = abs_text.get("Label", "")
                        text = abs_text.text or ""
                        if label:
                            abstract_parts.append(f"{label}: {text}")
                        else:
                            abstract_parts.append(text)
                abstract = " ".join(abstract_parts).strip()

                doi = ""
                elocation = art.find("ELocationID")
                if elocation is not None and elocation.get("EIdType") == "doi":
                    doi = elocation.text or ""
                pubmed_data = article.find("PubmedData")
                if pubmed_data is not None:
                    for aid in pubmed_data.findall("ArticleIdList/ArticleId"):
                        if aid.get("IdType") == "doi" and not doi:
                            doi = aid.text or ""

                pmid = medline.findtext("PMID", "") if medline is not None else ""
                url = format_external_url("data_sources.ncbi.pubmed_article_template", pmid=pmid) if pmid else ""

                sources.append({
                    "title": title,
                    "authors": authors,
                    "year": year,
                    "venue": venue,
                    "doi": doi,
                    "url": url,
                    "abstract": abstract[:1000] if abstract else "",
                    "source_database": "pubmed",
                    "pmid": pmid,
                })

            return sources

        except requests.exceptions.Timeout:
            if attempt == 0:
                print("NCBI efetch timeout. Retrying...", file=sys.stderr)
                continue
            else:
                print("NCBI efetch timeout after retry.", file=sys.stderr)
                return []
        except Exception as e:
            print(f"NCBI efetch error: {e}", file=sys.stderr)
            return []


def search_pubmed(keywords: str, max_results: int = 20, sort_by: str = "relevance",
                   start_date: str = None, end_date: str = None,
                   mesh_term: str = None, timeout: int = 30,
                   auto_variants: bool = True, strict_relevance: bool = True,
                   domain: str = None) -> dict:
    api_key = get_api_key()

    sort_map = {"relevance": "relevance", "date": "pub_date"}
    sort = sort_map.get(sort_by, "relevance")
    if not mesh_term and domain:
        mesh_term = domain_defaults(domain).get("pubmed_mesh")

    variants = [keywords]
    if auto_variants:
        variants = query_variants(keywords, limit=4)

    merged_pmids = []
    attempted_queries = []
    search_failed = False

    for idx, variant in enumerate(variants):
        title_abstract = auto_variants and len(variant.split()) >= 3
        pmids = esearch(variant, max_results, sort, start_date, end_date, mesh_term,
                        api_key, timeout, title_abstract)
        attempted_queries.append({
            "query": variant,
            "term": build_pubmed_term(variant, mesh_term, title_abstract),
            "title_abstract": title_abstract,
            "datetype": "pdat" if start_date or end_date else None,
            "mindate": format_pubmed_date(start_date) if start_date else None,
            "maxdate": format_pubmed_date(end_date) if end_date else None,
        })

        if pmids is None:
            search_failed = True
            continue
        for pmid in pmids:
            if pmid not in merged_pmids:
                merged_pmids.append(pmid)
            if len(merged_pmids) >= max_results:
                break
        if merged_pmids and (idx == 0 or len(merged_pmids) >= max_results):
            break

    if not merged_pmids and search_failed:
        return {
            "sources": [], "total_results": 0, "query": keywords,
            "database": "pubmed", "api_call_verified": False,
            "error": "search_failed",
            "query_variants": attempted_queries,
        }

    if not merged_pmids:
        return {
            "sources": [], "total_results": 0, "query": keywords,
            "database": "pubmed", "api_call_verified": True,
            "error": "no_results",
            "query_variants": attempted_queries,
        }

    sources = efetch(merged_pmids[:max_results], api_key, timeout)
    if strict_relevance:
        filtered = filter_relevant_sources(sources, keywords, min_score=5)
        if filtered:
            sources = filtered

    return {
        "sources": sources,
        "total_results": len(sources),
        "query": keywords,
        "database": "pubmed",
        "api_call_verified": True,
        "mesh_term_filter": mesh_term,
        "sort_by": sort_by,
        "date_range": f"{start_date or 'none'}-{end_date or 'none'}",
        "query_variants": attempted_queries,
    }


def main():
    parser = argparse.ArgumentParser(description="Search PubMed for biomedical papers")
    parser.add_argument("keywords", help="Core search keywords")
    parser.add_argument("--max-results", type=int, default=20, help="Maximum number of results")
    parser.add_argument("--sort-by", default="relevance", choices=["relevance", "date"])
    parser.add_argument("--start-date", default=None, help="Filter by publication date after (YYYY-MM-DD)")
    parser.add_argument("--end-date", default=None, help="Filter by publication date before (YYYY-MM-DD)")
    parser.add_argument("--mesh-term", default=None, help="MeSH term for domain-specific searches")
    parser.add_argument("--domain", default=None,
                        help="Optional domain used to infer a MeSH term when --mesh-term is omitted")
    parser.add_argument("--no-auto-variants", action="store_true",
                        help="Disable automatic short query variants and acronym expansion.")
    parser.add_argument("--no-strict-relevance", action="store_true",
                        help="Disable post-query relevance filtering.")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    parser.add_argument("--output", default=None,
                        help="Explicit output file path. If set, overrides auto-detection and writes to this path.")
    parser.add_argument("--output-dir", default=None,
                        help="Base directory for auto-generated output file. Defaults to JiuwenSwarm team-workspace auto-detection.")

    args = parser.parse_args()

    result = search_pubmed(args.keywords, args.max_results, args.sort_by,
                            args.start_date, args.end_date, args.mesh_term, args.timeout,
                            not args.no_auto_variants, not args.no_strict_relevance,
                            args.domain)

    handle_output(result, args)


if __name__ == "__main__":
    main()
