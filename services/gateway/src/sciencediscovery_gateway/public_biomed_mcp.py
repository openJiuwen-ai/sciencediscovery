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

"""Public biomedical MCP tools backed by provider-operated APIs.

These tools intentionally stop at structured records and artifact candidates.
All policy, permissions, cache, audit, normalization checks, and file-byte
downloads remain in the Node governance broker.
"""

from __future__ import annotations

import html
import hashlib
import json
import os
import re
import ssl
import time
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx
from mcp.server.fastmcp import FastMCP

from .external_urls import external_url, external_url_list, format_external_url

SERVER = FastMCP("biomed")
TIMEOUT = 30


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _raise_for_status(response: httpx.Response) -> None:
    """Raise a readable error that keeps the status and the Retry-After hint.

    ``response.raise_for_status()`` drops response headers, so the gateway
    retry loop could never honour upstream ``Retry-After`` values. Keep the
    message header-token friendly for its error classifier and avoid echoing
    the full request URL (it can embed the user query).
    """
    if response.status_code < 400:
        return
    message = f"HTTP {response.status_code} {response.reason_phrase} from {response.request.url.host}"
    retry_after = response.headers.get("retry-after")
    if retry_after:
        message += f" (retry-after: {retry_after})"
    raise RuntimeError(message)


def _log_arxiv_http(
    *, started_at: str, elapsed_ms: int, params: dict[str, Any] | None,
    response: httpx.Response | None, error_type: str | None,
) -> None:
    """Optional per-attempt diagnostics; never persist the raw research query."""
    path = os.environ.get("SCIENCE_AGENT_ARXIV_HTTP_LOG")
    if not path:
        return
    query = str((params or {}).get("search_query", ""))
    headers = response.headers if response is not None else {}
    event = {
        "at": started_at,
        "elapsed_ms": elapsed_ms,
        "pid": os.getpid(),
        "query_sha256": hashlib.sha256(query.encode()).hexdigest(),
        "status": response.status_code if response is not None else None,
        "error_type": error_type,
        "retry_after": headers.get("retry-after"),
        "date": headers.get("date"),
        "server": headers.get("server"),
        "via": headers.get("via"),
        "x_cache": headers.get("x-cache"),
        "cf_ray": headers.get("cf-ray"),
    }
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, (json.dumps(event, separators=(",", ":")) + "\n").encode())
        finally:
            os.close(descriptor)
    except OSError:
        # Diagnostics must never change the result of a provider call.
        pass


async def _get_json(url: str, *, params: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        response = await client.get(url, params=params, headers={"accept": "application/json"})
        _raise_for_status(response)
        return response.json()


async def _get_text(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    accept: str = "text/plain",
    ssl_context: ssl.SSLContext | None = None,
    arxiv_diagnostics: bool = False,
) -> str:
    client_options = {"verify": ssl_context} if ssl_context is not None else {}
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, **client_options) as client:
        started_at = _now()
        started = time.monotonic()
        response: httpx.Response | None = None
        error_type: str | None = None
        try:
            response = await client.get(url, params=params, headers={"accept": accept})
            _raise_for_status(response)
            return response.text
        except Exception as error:
            error_type = type(error).__name__
            raise
        finally:
            if arxiv_diagnostics:
                _log_arxiv_http(
                    started_at=started_at, elapsed_ms=round((time.monotonic() - started) * 1000),
                    params=params, response=response, error_type=error_type,
                )


async def _post_json(url: str, payload: Any) -> Any:
    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        response = await client.post(url, json=payload, headers={"accept": "application/json"})
        _raise_for_status(response)
        return {} if response.status_code == 204 else response.json()


def _citation(source: str, identifier: str, title: str, url: str, role: str = "database-record") -> dict[str, Any]:
    label = source if source in {"PDB", "GEO"} else source[0].upper() + source[1:]
    return {
        "identifier": identifier,
        "identifierType": f"{source} identifier",
        "label": f"{label} {identifier}: {title}",
        "markdown": f"[{label}:{identifier}]({url})",
        "role": role,
        "source": source.lower(),
        "url": url,
    }


def _record(
    source: str,
    identifier: str,
    title: str,
    url: str,
    data: Any,
    *,
    abstract: str | None = None,
    authors: list[str] | None = None,
    role: str = "database-record",
    scope: str = "structured-record",
    warnings: list[str] | None = None,
    year: str | None = None,
) -> dict[str, Any]:
    citation = _citation(source, identifier, title, url, role)
    return {
        **({"abstract": abstract} if abstract else {}),
        "authors": authors or [],
        "citations": [citation],
        "contentScope": scope,
        "crossReferences": [],
        "fullTextRetrieved": False,
        "identifier": identifier,
        "identifierType": citation["identifierType"],
        "primaryCitation": citation,
        "source": source.lower(),
        "structuredData": data,
        "title": title,
        "url": url,
        "warnings": warnings or [],
        **({"year": year} if year else {}),
    }


def _result(
    source: str,
    tool: str,
    records: list[dict[str, Any]],
    *,
    artifacts: list[dict[str, Any]] | None = None,
    data: Any | None = None,
    warnings: list[str] | None = None,
    source_version: str | None = None,
) -> dict[str, Any]:
    return {
        **({"artifacts": artifacts} if artifacts is not None else {}),
        "attribution": source,
        **({"data": data} if data is not None else {}),
        "license": "Provider terms apply",
        "records": records,
        "retrievedAt": _now(),
        "sourceId": source.lower(),
        "toolId": tool,
        "untrusted": True,
        "warnings": warnings or [],
        **({"sourceVersion": source_version} if source_version else {}),
    }


def _page(limit: int, offset: int = 0) -> None:
    if not 1 <= limit <= 25 or offset < 0:
        raise ValueError("limit must be between 1 and 25 and offset must be nonnegative")


def _version(record: dict[str, Any], version: Any) -> dict[str, Any]:
    if version is not None and str(version):
        for citation in record["citations"]:
            citation["sourceVersion"] = str(version)
        record["primaryCitation"]["sourceVersion"] = str(version)
    return record


def _provider_file(url: str, source: str) -> str:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in external_url_list(f"connector_hosts.{source}")
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError(f"File URL is outside the {source} provider host allowlist")
    return url


# arXiv / PubMed / Europe PMC


def _clean(value: Any, limit: int = 4_000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


async def _arxiv_search(query: str, limit: int) -> dict[str, Any]:
    # arXiv's edge rejects cold requests from the default httpx TLS handshake
    # with HTTP 406. Advertising post-handshake auth restores the origin path;
    # it does not disable certificate verification or present a client cert.
    ssl_context = ssl.create_default_context()
    ssl_context.post_handshake_auth = True
    payload = await _get_text(
        external_url("data_sources.arxiv.api_query"),
        params={
            "max_results": max(1, min(limit, 25)),
            "search_query": query if ":" in query else f"all:{query}",
            "start": 0,
        },
        accept="application/atom+xml",
        ssl_context=ssl_context,
        arxiv_diagnostics=True,
    )
    root = ET.fromstring(payload)
    atom = {"atom": "http://www.w3.org/2005/Atom"}
    records: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", atom):
        raw_id = _clean(entry.findtext("atom:id", default="", namespaces=atom), 200)
        article_prefix = format_external_url("data_sources.arxiv.article_template", identifier="")
        identifier = raw_id.removeprefix(article_prefix).removeprefix(article_prefix.replace("https://", "http://", 1))
        if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[A-Za-z.-]+/\d{7})(?:v\d+)?", identifier):
            continue
        title = _clean(entry.findtext("atom:title", default="", namespaces=atom), 1_000) or f"arXiv {identifier}"
        abstract = _clean(entry.findtext("atom:summary", default="", namespaces=atom), 20_000)
        authors = [
            _clean(author.findtext("atom:name", default="", namespaces=atom), 200)
            for author in entry.findall("atom:author", atom)
        ]
        published = _clean(entry.findtext("atom:published", default="", namespaces=atom), 40)
        records.append(_record(
            "arxiv",
            identifier,
            title,
            format_external_url("data_sources.arxiv.article_template", identifier=identifier),
            {"published": published, "updated": _clean(entry.findtext("atom:updated", default="", namespaces=atom), 40)},
            abstract=abstract or None,
            authors=[author for author in authors if author],
            role="preprint",
            scope="abstract" if abstract else "metadata",
            warnings=["arXiv records are preprints or e-prints; preserve the submitted version."],
            year=published[:4] if re.match(r"\d{4}", published) else None,
        ))
    return _result("arxiv", "search", records)


async def _pubmed_search(query: str, limit: int) -> dict[str, Any]:
    search = await _get_json(
        external_url("data_sources.ncbi.eutils_esearch"),
        params={"db": "pubmed", "retmax": max(1, min(limit, 25)), "retmode": "json", "term": query},
    )
    ids = [
        value for value in search.get("esearchresult", {}).get("idlist", [])
        if re.fullmatch(r"\d{1,9}", str(value))
    ][:limit]
    if not ids:
        return _result("pubmed", "search", [])
    summaries = await _get_json(
        external_url("data_sources.ncbi.eutils_esummary"),
        params={"db": "pubmed", "id": ",".join(ids), "retmode": "json"},
    )
    result = summaries.get("result", {})
    records: list[dict[str, Any]] = []
    for pmid in ids:
        item = result.get(pmid, {})
        title = _clean(item.get("title"), 1_000) or f"PubMed {pmid}"
        authors = [_clean(author.get("name"), 200) for author in item.get("authors", []) if isinstance(author, dict)]
        pubdate = _clean(item.get("pubdate"), 40)
        records.append(_record(
            "pubmed",
            pmid,
            title,
            format_external_url("data_sources.ncbi.pubmed_article_template", pmid=pmid),
            item,
            authors=[author for author in authors if author],
            role="primary-literature",
            scope="metadata",
            year=(re.search(r"\d{4}", pubdate).group(0) if re.search(r"\d{4}", pubdate) else None),
        ))
    return _result("pubmed", "search", records)


async def _europe_pmc_search(query: str, limit: int) -> dict[str, Any]:
    payload = await _get_json(
        external_url("data_sources.europe_pmc.search_api"),
        params={"format": "json", "pageSize": max(1, min(limit, 25)), "query": query, "resultType": "core"},
    )
    records: list[dict[str, Any]] = []
    for item in payload.get("resultList", {}).get("result", []):
        pmcid = _clean(item.get("pmcid"), 32).upper()
        source_id = _clean(item.get("id"), 80)
        source = _clean(item.get("source"), 20).upper()
        identifier = pmcid if re.fullmatch(r"PMC\d{1,12}", pmcid) else source_id
        if not identifier:
            continue
        title = _clean(item.get("title"), 1_000) or f"Europe PMC {identifier}"
        abstract = _clean(item.get("abstractText"), 20_000)
        url = (
            format_external_url("data_sources.europe_pmc.pmc_article_template", identifier=pmcid)
            if pmcid
            else format_external_url(
                "data_sources.europe_pmc.article_template", source=source or "MED", identifier=source_id
            )
        )
        records.append(_record(
            "europe-pmc",
            identifier,
            title,
            url,
            item,
            abstract=abstract or None,
            authors=[name.strip() for name in _clean(item.get("authorString"), 4_000).split(",") if name.strip()],
            role="primary-literature",
            scope="abstract" if abstract else "metadata",
            year=_clean(item.get("firstPublicationDate"), 40)[:4] or None,
        ))
    return _result("europe-pmc", "search", records)


async def _pmc_pdf_candidate(source: str, identifier: str) -> dict[str, Any]:
    pmcid = identifier.strip().upper()
    if source == "pubmed":
        links = await _get_text(
            external_url("data_sources.ncbi.eutils_elink"),
            params={"db": "pmc", "dbfrom": "pubmed", "id": identifier, "linkname": "pubmed_pmc", "retmode": "xml"},
            accept="application/xml",
        )
        root = ET.fromstring(links)
        linked = root.findtext(".//LinkSetDb/Link/Id", default="")
        if not re.fullmatch(r"\d{1,12}", linked):
            raise ValueError(f"PubMed {identifier} has no linked open-access PMC record")
        pmcid = f"PMC{linked}"
    if not re.fullmatch(r"PMC\d{1,12}", pmcid):
        raise ValueError("PDF preparation requires a PMID or PMCID")
    locator = await _get_text(
        external_url("data_sources.ncbi.pmc_oa"),
        params={"id": pmcid},
        accept="application/xml",
    )
    root = ET.fromstring(locator)
    error = root.find(".//error")
    if error is not None:
        raise ValueError(f"PMC OA PDF is unavailable ({error.attrib.get('code', 'unknown reason')})")
    record = root.find(".//record")
    pdf = root.find(".//link[@format='pdf']")
    href = pdf.attrib.get("href") if pdf is not None else None
    if not href:
        raise ValueError("PMC OA record does not provide a PDF")
    href = re.sub(r"^ftp://", "https://", href)
    if not href.startswith(external_url("data_sources.ncbi.pmc_ftp_https_prefix")):
        raise ValueError("PMC OA PDF URL escaped its fixed host allowlist")
    license_name = record.attrib.get("license", "NCBI PMC open-access article license") if record is not None else "NCBI PMC open-access article license"
    return _result(source, "prepare_paper_download", [], artifacts=[{
        "attribution": "Open-access article PDF provided by PubMed Central.",
        "format": "pdf",
        "id": f"{source}:{identifier}:pdf",
        "kind": "paper",
        "license": license_name,
        "logicalName": f"{source}-{identifier}-{pmcid}.pdf",
        "mimeType": "application/pdf",
        "sourceId": source,
        "sourceRecordId": identifier,
        "sourceUrl": href,
    }], warnings=["The PDF is a download candidate and has not been downloaded or read yet."])


@SERVER.tool()
async def arxiv_search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search arXiv metadata and abstracts."""
    return await _arxiv_search(query, limit)


@SERVER.tool()
async def arxiv_prepare_paper_download(identifier: str) -> dict[str, Any]:
    """Prepare an arXiv PDF download candidate."""
    normalized = identifier.strip()
    if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[A-Za-z.-]+/\d{7})(?:v\d+)?", normalized):
        raise ValueError("Invalid arXiv identifier")
    return _result("arxiv", "prepare_paper_download", [], artifacts=[{
        "attribution": "arXiv e-print provided by Cornell University.",
        "format": "pdf",
        "id": f"arxiv:{normalized}:pdf",
        "kind": "paper",
        "license": "Per-record arXiv submission license",
        "logicalName": f"arxiv-{normalized.replace('/', '_')}.pdf",
        "mimeType": "application/pdf",
        "sourceId": "arxiv",
        "sourceRecordId": normalized,
        "sourceUrl": format_external_url("data_sources.arxiv.pdf_template", identifier=normalized),
    }], warnings=["The PDF is a download candidate and has not been downloaded or read yet."])


@SERVER.tool()
async def pubmed_search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search PubMed metadata."""
    return await _pubmed_search(query, limit)


@SERVER.tool()
async def pubmed_prepare_paper_download(identifier: str) -> dict[str, Any]:
    """Prepare the linked open-access PMC PDF for a PMID."""
    if not re.fullmatch(r"\d{1,9}", identifier.strip()):
        raise ValueError("PubMed PDF preparation requires a PMID")
    return await _pmc_pdf_candidate("pubmed", identifier.strip())


@SERVER.tool(name="europe-pmc_search")
async def europe_pmc_search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search Europe PMC metadata and abstracts."""
    return await _europe_pmc_search(query, limit)


@SERVER.tool(name="europe-pmc_prepare_paper_download")
async def europe_pmc_prepare_paper_download(identifier: str) -> dict[str, Any]:
    """Prepare an open-access PMC PDF for a PMCID."""
    return await _pmc_pdf_candidate("europe-pmc", identifier)


# bioRxiv / medRxiv


async def _preprint_search(server: str, query: str, days: int, limit: int, category: str | None) -> dict[str, Any]:
    if not query.strip():
        raise ValueError("query must not be empty")
    payload = await _get_json(
        format_external_url("data_sources.preprints.details_by_days_template", server=server, days=days),
        params={"category": category} if category else None,
    )
    terms = query.lower().split()
    records = []
    for item in payload.get("collection", []):
        searchable = " ".join(str(item.get(key, "")) for key in ("title", "abstract", "authors", "category")).lower()
        if terms and not all(term in searchable for term in terms):
            continue
        doi = str(item.get("doi", ""))
        title = str(item.get("title", doi))
        url = format_external_url(
            "data_sources.preprints.content_template", server=server, doi=doi, version=item.get("version", "1")
        )
        records.append(_record(
            server,
            doi,
            title,
            url,
            item,
            abstract=str(item.get("abstract", "")) or None,
            authors=[name.strip() for name in str(item.get("authors", "")).split(";") if name.strip()],
            role="preprint",
            scope="abstract",
            warnings=["This record is a preprint and has not completed peer review."],
            year=str(item.get("date", ""))[:4] or None,
        ))
        if len(records) >= limit:
            break
    return _result(
        server,
        "search_preprints",
        records,
        warnings=["The provider API exposes date/category retrieval; text filtering was applied to the returned recent window."],
    )


async def _preprint_lookup(server: str, doi: str) -> dict[str, Any]:
    payload = await _get_json(format_external_url(
        "data_sources.preprints.details_by_doi_template", server=server, doi=quote(doi, safe="/")
    ))
    records = []
    for item in payload.get("collection", []):
        identifier = str(item.get("doi", doi))
        title = str(item.get("title", identifier))
        url = format_external_url(
            "data_sources.preprints.content_template",
            server=server,
            doi=identifier,
            version=item.get("version", "1"),
        )
        records.append(_record(
            server, identifier, title, url, item,
            abstract=str(item.get("abstract", "")) or None,
            authors=[name.strip() for name in str(item.get("authors", "")).split(";") if name.strip()],
            role="preprint", scope="abstract",
            warnings=["This record is a preprint and has not completed peer review."],
            year=str(item.get("date", ""))[:4] or None,
        ))
    return _result(server, "lookup_doi", records)

async def _preprint_prepare_pdf(server: str, doi: str, version: int | None) -> dict[str, Any]:
    normalized = doi.strip()
    if not re.fullmatch(r"10\.1101/.+", normalized):
        raise ValueError("doi must be a bioRxiv/medRxiv DOI beginning with 10.1101/")
    payload = await _get_json(format_external_url(
        "data_sources.preprints.details_by_doi_template", server=server, doi=quote(normalized, safe="/")
    ))
    collection = payload.get("collection", [])
    if not collection:
        raise ValueError(f"{server} did not return a record for {normalized}")
    versions = [
        int(item.get("version", 1))
        for item in collection
        if str(item.get("version", "1")).isdigit()
    ]
    selected_version = version if version is not None else max(versions or [1])
    if selected_version not in versions:
        raise ValueError(f"{server} record {normalized} does not provide version {selected_version}")
    logical_doi = normalized.replace("/", "_")
    return _result(server, "prepare_paper_download", [], artifacts=[{
        "attribution": f"Preprint PDF provided by {server}.",
        "format": "pdf",
        "id": f"{server}:{normalized}:v{selected_version}:pdf",
        "kind": "paper",
        "license": f"{server} article license; verify the per-record license before redistribution",
        "logicalName": f"{server}-{logical_doi}-v{selected_version}.pdf",
        "mimeType": "application/pdf",
        "sourceId": server,
        "sourceRecordId": normalized,
        "sourceUrl": format_external_url(
            "data_sources.preprints.pdf_template",
            server=server,
            doi=normalized,
            version=selected_version,
        ),
    }], warnings=["The PDF is a download candidate and has not been downloaded or read yet."])


@SERVER.tool()
async def biorxiv_search_preprints(query: str, days: int = 30, limit: int = 5, category: str | None = None) -> dict[str, Any]:
    """Search recent bioRxiv preprints."""
    return await _preprint_search("biorxiv", query, days, limit, category)


@SERVER.tool()
async def biorxiv_lookup_doi(doi: str) -> dict[str, Any]:
    """Look up a bioRxiv DOI."""
    return await _preprint_lookup("biorxiv", doi)

@SERVER.tool()
async def biorxiv_prepare_paper_download(doi: str, version: int | None = None) -> dict[str, Any]:
    """Prepare a bioRxiv PDF candidate without downloading bytes."""
    return await _preprint_prepare_pdf("biorxiv", doi, version)


@SERVER.tool()
async def medrxiv_search_preprints(query: str, days: int = 30, limit: int = 5, category: str | None = None) -> dict[str, Any]:
    """Search recent medRxiv preprints."""
    return await _preprint_search("medrxiv", query, days, limit, category)


@SERVER.tool()
async def medrxiv_lookup_doi(doi: str) -> dict[str, Any]:
    """Look up a medRxiv DOI."""
    return await _preprint_lookup("medrxiv", doi)


@SERVER.tool()
async def medrxiv_prepare_paper_download(doi: str, version: int | None = None) -> dict[str, Any]:
    """Prepare a medRxiv PDF candidate without downloading bytes."""
    return await _preprint_prepare_pdf("medrxiv", doi, version)


# RCSB PDB


async def _pdb_entry(pdb_id: str) -> dict[str, Any]:
    normalized = pdb_id.upper()
    if not re.fullmatch(r"[A-Z0-9]{4}", normalized):
        raise ValueError("pdb_id must contain four letters or digits")
    return await _get_json(format_external_url("data_sources.rcsb.entry_template", identifier=normalized))


def _pdb_record(pdb_id: str, data: dict[str, Any]) -> dict[str, Any]:
    title = str(data.get("struct", {}).get("title") or f"PDB {pdb_id}")
    info = data.get("rcsb_entry_info", {})
    accession = data.get("rcsb_accession_info", {})
    return _version(_record(
        "pdb", pdb_id, title,
        format_external_url("data_sources.rcsb.structure_template", identifier=pdb_id), {**data, "structureType": "experimental"},
        scope="curated-record",
        year=str(accession.get("initial_release_date", ""))[:4] or None,
        warnings=[
            f"Experimental method/resolution metadata must be interpreted from the structured record; resolution_combined={info.get('resolution_combined')}."
        ],
    ), accession.get("revision_date") or accession.get("initial_release_date"))


@SERVER.tool()
async def pdb_search_structures(query: str, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Full-text search released PDB structures."""
    _page(limit, offset)
    search = await _post_json(external_url("data_sources.rcsb.search_api"), {
        "query": {"type": "terminal", "service": "full_text", "parameters": {"value": query}},
        "request_options": {"paginate": {"start": offset, "rows": limit}, "results_content_type": ["experimental"]},
        "return_type": "entry",
    })
    records = []
    for hit in search.get("result_set", [])[:limit]:
        pdb_id = str(hit.get("identifier", "")).upper()
        if pdb_id:
            records.append(_pdb_record(pdb_id, await _pdb_entry(pdb_id)))
    return _result("pdb", "search_structures", records, data=_pagination(search.get("total_count"), offset, len(records), limit))


@SERVER.tool()
async def pdb_lookup_structure(pdb_id: str) -> dict[str, Any]:
    """Look up one PDB structure."""
    normalized = pdb_id.upper()
    return _result("pdb", "lookup_structure", [_pdb_record(normalized, await _pdb_entry(normalized))])


@SERVER.tool()
async def pdb_prepare_structure_download(pdb_id: str, format: str = "cif") -> dict[str, Any]:
    """Prepare an RCSB structure file candidate without downloading bytes."""
    normalized = pdb_id.upper()
    entry = await _pdb_entry(normalized)
    if format not in {"cif", "pdb"}:
        raise ValueError("format must be cif or pdb")
    return _result("pdb", "prepare_structure_download", [_pdb_record(normalized, entry)], artifacts=[{
        "attribution": "Structure file provided by RCSB PDB.",
        "format": format,
        "id": f"pdb:{normalized}:{format}",
        "kind": "structure",
        "license": "RCSB PDB data usage policy",
        "logicalName": f"{normalized}.{format}",
        "mimeType": "chemical/x-mmcif" if format == "cif" else "chemical/x-pdb",
        "sourceId": "pdb",
        "sourceRecordId": normalized,
        "sourceUrl": format_external_url(
            "data_sources.rcsb.download_template", identifier=normalized, format=format
        ),
    }])


# AlphaFold DB (existing predictions; no prediction jobs)


async def _alphafold_predictions(accession: str) -> list[dict[str, Any]]:
    normalized = accession.upper()
    if not re.fullmatch(r"(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[0-9]+)?", normalized):
        raise ValueError("accession must be a UniProt accession")
    predictions = await _get_json(format_external_url("data_sources.alphafold.prediction_template", accession=normalized))
    if not isinstance(predictions, list):
        raise ValueError("AlphaFold DB did not return a prediction list")
    if len(predictions) > 25:
        raise ValueError("More than 25 prediction fragments returned; select a smaller protein entry")
    return predictions


def _alphafold_record(item: dict[str, Any]) -> dict[str, Any]:
    identifier = str(item.get("entryId") or item.get("modelEntityId") or "")
    accession = str(item.get("uniprotAccession") or "")
    if not identifier or not accession:
        raise ValueError("AlphaFold prediction is missing its model identifier or accession")
    record = _version(_record(
        "alphafold", identifier, str(item.get("uniprotDescription") or identifier),
        format_external_url("data_sources.alphafold.entry_template", accession=accession),
        {**item, "structureType": "predicted"}, scope="curated-record",
        warnings=["Predicted structure, not experimental evidence. Interpret pLDDT locally and PAE for relative domain placement."],
    ), item.get("latestVersion"))
    record["crossReferences"] = [{"source": "uniprot", "identifier": accession}]
    return record


@SERVER.tool()
async def alphafold_lookup_prediction(accession: str) -> dict[str, Any]:
    """Retrieve existing AlphaFold DB models and confidence metadata by UniProt accession."""
    items = await _alphafold_predictions(accession)
    return _result("alphafold", "lookup_prediction", [_alphafold_record(item) for item in items],
                   warnings=[] if items else ["No prediction is available for this accession."])


@SERVER.tool()
async def alphafold_prepare_prediction_download(accession: str, format: str = "cif", model_id: str | None = None) -> dict[str, Any]:
    """Prepare existing model, pLDDT, or PAE files for governed download; never run prediction."""
    fields = {"cif": "cifUrl", "pdb": "pdbUrl", "plddt": "plddtDocUrl", "pae": "paeDocUrl"}
    if format not in fields:
        raise ValueError("format must be cif, pdb, plddt, or pae")
    items = await _alphafold_predictions(accession)
    if model_id is not None:
        items = [item for item in items if model_id == (item.get("entryId") or item.get("modelEntityId"))]
        if not items:
            raise ValueError("The requested model_id is not available for this accession")
    records = [_alphafold_record(item) for item in items]
    artifacts = []
    warnings = []
    for item, record in zip(items, records):
        url = item.get(fields[format])
        if not url:
            warnings.append(f"{format} file is not available for {record['identifier']}")
            continue
        url = _provider_file(str(url), "alphafold")
        name = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
        artifacts.append({
            "attribution": "Prediction provided by AlphaFold DB (Google DeepMind and EMBL-EBI).",
            "format": format if format in {"cif", "pdb"} else "json",
            "id": f"alphafold:{record['identifier']}:v{item.get('latestVersion')}:{format}",
            "kind": "structure" if format in {"cif", "pdb"} else "dataset",
            "license": "CC BY 4.0", "logicalName": name,
            "mimeType": {"cif": "chemical/x-mmcif", "pdb": "chemical/x-pdb"}.get(format, "application/json"),
            "sourceId": "alphafold", "sourceRecordId": record["identifier"], "sourceUrl": url,
        })
    return _result("alphafold", "prepare_prediction_download", records, artifacts=artifacts,
                   warnings=warnings or ([] if items else ["No prediction is available for this accession."]))


# Ensembl


def _ensembl_record(identifier: str, data: Any, kind: str) -> dict[str, Any]:
    item = data if isinstance(data, dict) else {}
    title = str(item.get("display_name") or item.get("external_name") or f"Ensembl {kind} {identifier}")
    return _record(
        "ensembl", identifier, title,
        format_external_url("data_sources.ensembl.id_template", identifier=identifier),
        data, scope="curated-record",
    )


async def _ensembl_lookup(identifier: str, tool: str) -> dict[str, Any]:
    data = await _get_json(
        format_external_url("data_sources.ensembl.lookup_template", identifier=quote(identifier)),
        params={"expand": 1},
    )
    return _result("ensembl", tool, [_ensembl_record(identifier, data, tool)])


@SERVER.tool()
async def ensembl_lookup_gene(id: str, species: str = "human") -> dict[str, Any]:
    """Look up one Ensembl gene stable ID."""
    del species
    return await _ensembl_lookup(id, "lookup_gene")


@SERVER.tool()
async def ensembl_lookup_transcript(id: str, species: str = "human") -> dict[str, Any]:
    """Look up one Ensembl transcript stable ID."""
    del species
    return await _ensembl_lookup(id, "lookup_transcript")


@SERVER.tool()
async def ensembl_overlap_region(region: str, species: str = "human", feature: str = "gene") -> dict[str, Any]:
    """Retrieve Ensembl features overlapping a region."""
    data = await _get_json(
        format_external_url(
            "data_sources.ensembl.overlap_template",
            species=quote(species),
            region=quote(region, safe=":.-"),
        ),
        params={"feature": feature},
    )
    records = [
        _ensembl_record(str(item.get("id", f"{region}:{index}")), item, feature)
        for index, item in enumerate(data[:100])
    ]
    return _result("ensembl", "overlap_region", records, warnings=["Results are capped at 100 features."])


@SERVER.tool()
async def ensembl_variant_consequence(id: str, species: str = "human") -> dict[str, Any]:
    """Fetch Ensembl VEP consequences for a known variant."""
    data = await _get_json(format_external_url(
        "data_sources.ensembl.vep_template", species=quote(species), identifier=quote(id)
    ))
    record = _record(
        "ensembl", id, f"Variant consequences for {id}",
        format_external_url("data_sources.ensembl.variation_template", species=species, identifier=quote(id)),
        data, scope="analysis-result",
    )
    return _result("ensembl", "variant_consequence", [record])


# Reactome


@SERVER.tool()
async def reactome_search_pathways(query: str, limit: int = 5, species: str = "Homo sapiens") -> dict[str, Any]:
    """Search Reactome pathways."""
    data = await _get_json(
        external_url("data_sources.reactome.search_api"),
        params={"query": query, "species": species, "types": "Pathway", "cluster": "true"},
    )
    entries = data.get("results", data if isinstance(data, list) else [])
    records = []
    for item in entries[:limit]:
        identifier = str(item.get("stId") or item.get("dbId") or "")
        title = str(item.get("name") or item.get("displayName") or identifier)
        if identifier:
            records.append(_record(
                "reactome", identifier, title,
                format_external_url("data_sources.reactome.detail_template", identifier=identifier),
                item, scope="curated-record",
            ))
    return _result("reactome", "search_pathways", records)


@SERVER.tool()
async def reactome_lookup_pathway(id: str) -> dict[str, Any]:
    """Look up one Reactome stable pathway identifier."""
    data = await _get_json(format_external_url("data_sources.reactome.data_query_template", identifier=quote(id)))
    title = str(data.get("displayName") or id)
    return _result("reactome", "lookup_pathway", [
        _record(
            "reactome", id, title,
            format_external_url("data_sources.reactome.detail_template", identifier=id),
            data, scope="curated-record",
        )
    ])


@SERVER.tool()
async def reactome_enrichment(identifiers: list[str], species: str = "Homo sapiens") -> dict[str, Any]:
    """Run Reactome over-representation analysis."""
    if not identifiers or len(identifiers) > 500:
        raise ValueError("identifiers must contain 1 to 500 values")
    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        response = await client.post(
            external_url("data_sources.reactome.analysis_api"),
            content="\n".join(identifiers),
            params={"pageSize": 100, "page": 1, "species": species},
            headers={"accept": "application/json", "content-type": "text/plain"},
        )
        response.raise_for_status()
        data = response.json()
    pathways = data.get("pathways", [])
    records = []
    for item in pathways[:100]:
        identifier = str(item.get("stId") or "")
        if identifier:
            records.append(_record(
                "reactome", identifier, str(item.get("name") or identifier),
                format_external_url("data_sources.reactome.detail_template", identifier=identifier),
                item, scope="analysis-result",
            ))
    return _result("reactome", "enrichment", records, data={"summary": data.get("summary")})


# NCBI ClinVar / GEO helpers


async def _entrez_search(db: str, term: str, limit: int) -> list[str]:
    data = await _get_json(
        external_url("data_sources.ncbi.eutils_esearch"),
        params={"db": db, "retmax": min(limit, 25), "retmode": "json", "term": term},
    )
    return [str(item) for item in data.get("esearchresult", {}).get("idlist", [])]


async def _entrez_summary(db: str, ids: list[str]) -> list[dict[str, Any]]:
    if not ids:
        return []
    data = await _get_json(
        external_url("data_sources.ncbi.eutils_esummary"),
        params={"db": db, "id": ",".join(ids), "retmode": "json", "version": "2.0"},
    )
    result = data.get("result", {})
    return [result[item] for item in result.get("uids", ids) if isinstance(result.get(item), dict)]


def _clinvar_record(item: dict[str, Any]) -> dict[str, Any]:
    identifier = str(item.get("accession") or item.get("uid") or item.get("variation_id") or "")
    title = str(item.get("title") or item.get("variation_name") or f"ClinVar {identifier}")
    return _record(
        "clinvar", identifier, title,
        format_external_url(
            "data_sources.ncbi.clinvar_variation_template",
            variation_id=item.get("variation_id") or item.get("uid"),
        ),
        item, scope="curated-record",
        warnings=["Review status and conflicting submissions must not be collapsed into one assertion."],
    )


@SERVER.tool()
async def clinvar_search_variants(query: str, limit: int = 5) -> dict[str, Any]:
    """Search ClinVar with Entrez syntax."""
    items = await _entrez_summary("clinvar", await _entrez_search("clinvar", query, limit))
    return _result("clinvar", "search_variants", [_clinvar_record(item) for item in items])


@SERVER.tool()
async def clinvar_lookup_accession(accession: str) -> dict[str, Any]:
    """Look up a ClinVar accession."""
    accession = _clinvar_accession(accession)
    ids = [accession] if accession.isdigit() else await _entrez_search("clinvar", f"{accession.split('.')[0]}[accn]", 5)
    items = await _entrez_summary("clinvar", ids)
    return _result("clinvar", "lookup_accession", [_clinvar_record(item) for item in items])


def _clinvar_accession(accession: str) -> str:
    value = accession.upper()
    if not re.fullmatch(r"(?:(?:VCV|RCV)\d{9}(?:\.\d+)?|\d+)", value):
        raise ValueError("accession must be a VCV/RCV accession or numeric Variation ID")
    return value


def _xml_data(element: ET.Element) -> dict[str, Any]:
    """Keep repeated nodes and attributes, including conflicting submitted assertions."""
    result: dict[str, Any] = {"attributes": dict(element.attrib)}
    if element.text and element.text.strip():
        result["text"] = element.text.strip()
    for child in element:
        result.setdefault(child.tag, []).append(_xml_data(child))
    return result


def _clinvar_assertion_records(xml: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml)
    if root.find(".//ERROR") is not None:
        raise ValueError("ClinVar returned an error instead of an assertion record")
    archives = list(root.iter("VariationArchive")) or list(root.iter("ClinVarSet"))
    records = []
    for archive in archives:
        reference = archive.find("ReferenceClinVarAssertion")
        owner = archive if reference is None else reference
        acc = owner.find("ClinVarAccession")
        identifier = str(archive.get("Accession") or (acc.get("Acc", "") if acc is not None else ""))
        if not identifier:
            raise ValueError("ClinVar record is missing its accession")
        version = archive.get("Version") or (acc.get("Version") if acc is not None else None)
        assertions = []
        for assertion in [*archive.iter("ClinicalAssertion"), *archive.iter("ClinVarAssertion")]:
            scv = assertion.find("ClinVarAccession")
            classifications = []
            for tag in ("ClinicalSignificance", "GermlineClassification", "SomaticClinicalImpact", "OncogenicityClassification", "Classification"):
                for classification in assertion.iter(tag):
                    classifications.append({"kind": tag, **_xml_data(classification)})
            assertions.append({
                "accession": scv.get("Accession", scv.get("Acc", "")) if scv is not None else "",
                "version": scv.get("Version") if scv is not None else None,
                "classifications": classifications,
                "submission": _xml_data(assertion),
            })
        variation_id = archive.get("VariationID")
        url = (format_external_url("data_sources.ncbi.clinvar_variation_template", variation_id=variation_id)
               if variation_id else format_external_url("data_sources.ncbi.clinvar_accession_template", accession=identifier))
        record = _version(_record(
            "clinvar", identifier, archive.get("VariationName") or owner.findtext(".//ElementValue") or identifier, url,
            {"accession": identifier, "version": version, "assertions": assertions,
             "record": _xml_data(owner), "assemblies": [dict(node.attrib) for node in owner.iter("SequenceLocation")]},
            scope="curated-record",
            warnings=["Individual submitted classifications and review statuses are not a consensus; inspect conditions and dates."],
        ), version)
        records.append(record)
    return records


@SERVER.tool()
async def clinvar_get_assertions(accession: str) -> dict[str, Any]:
    """Retrieve versioned ClinVar records with separate submitted assertions."""
    accession = _clinvar_accession(accession)
    params = {"db": "clinvar", "id": accession, "rettype": "clinvarset" if accession.startswith("RCV") else "vcv", "retmode": "xml"}
    if accession.isdigit():
        params["is_variationid"] = "true"
    xml = await _get_text(
        external_url("data_sources.ncbi.eutils_efetch"),
        params=params,
        accept="application/xml",
    )
    if len(xml.encode()) > 1_500_000:
        raise ValueError("ClinVar assertion record exceeds the supported size; retrieve the provider's bulk XML separately")
    records = _clinvar_assertion_records(xml)
    return _result(
        "clinvar", "get_assertions", records,
        warnings=[] if records else ["No ClinVar assertion record was returned for this accession."],
    )


# ChEMBL


def _chembl_records(kind: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    for item in items:
        identifier = str(item.get(f"{kind}_chembl_id") or item.get("activity_id") or item.get("molecule_chembl_id") or "")
        title = str(item.get("pref_name") or item.get("target_pref_name") or item.get("standard_type") or identifier)
        if identifier:
            records.append(_record(
                "chembl", identifier, title,
                format_external_url("data_sources.chembl.activity_template", identifier=identifier) if kind == "activity" else format_external_url(
                    "data_sources.chembl.explore_template",
                    kind=kind,
                    identifier=identifier.removeprefix("CHEMBL"),
                ),
                item, scope="curated-record",
            ))
    return records


def _pagination(total: Any, offset: int, returned: int, limit: int) -> dict[str, Any]:
    total = int(total) if total is not None else None
    more = offset + returned < total if total is not None else returned == limit
    return {"offset": offset, "limit": limit, "returned": returned, "total": total,
            "hasMore": more, "nextOffset": offset + returned if more and returned else None}


def _chembl_result(tool: str, kind: str, data: dict[str, Any], offset: int, limit: int) -> dict[str, Any]:
    key = {"activity": "activities", "molecule": "molecules", "target": "targets"}[kind]
    items = data.get(key, [])
    page = _pagination(data.get("page_meta", {}).get("total_count"), offset, len(items), limit)
    return _result("chembl", tool, _chembl_records(kind, items), data={"pagination": page},
                   warnings=["This is one page of results; continue with nextOffset to retrieve more."] if page["hasMore"] else [])


async def _chembl_search(resource: str, query: str, limit: int, offset: int) -> dict[str, Any]:
    _page(limit, offset)
    data = await _get_json(
        format_external_url("data_sources.chembl.resource_search_template", resource=resource),
        params={"q": query, "limit": limit, "offset": offset},
    )
    plural = {"molecule": "molecules", "target": "targets"}[resource]
    return _chembl_result(f"search_{plural}", resource, data, offset, limit)


@SERVER.tool()
async def chembl_search_molecules(query: str, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Search ChEMBL molecules."""
    return await _chembl_search("molecule", query, limit, offset)


@SERVER.tool()
async def chembl_search_targets(query: str, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Search ChEMBL targets."""
    return await _chembl_search("target", query, limit, offset)


@SERVER.tool()
async def chembl_search_activities(
    limit: int = 5, molecule_chembl_id: str | None = None, target_chembl_id: str | None = None,
    offset: int = 0, standard_type: str | None = None, standard_units: str | None = None,
    standard_relation: str | None = None, standard_value_max: float | None = None,
    assay_type: str | None = None, target_organism: str | None = None,
    confidence_score_min: int | None = None,
) -> dict[str, Any]:
    """Retrieve one page of measured activities with explicit assay and measurement constraints."""
    _page(limit, offset)
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    for key, identifier in (("molecule_chembl_id", molecule_chembl_id), ("target_chembl_id", target_chembl_id)):
        if identifier:
            if not re.fullmatch(r"CHEMBL\d+", identifier):
                raise ValueError(f"{key} must be a ChEMBL identifier")
            params[key] = identifier
    if not molecule_chembl_id and not target_chembl_id:
        raise ValueError("molecule_chembl_id or target_chembl_id is required")
    if standard_relation is not None and standard_relation not in {"=", "<", "<=", ">", ">=", "~"}:
        raise ValueError("Unsupported standard_relation")
    if assay_type is not None and assay_type not in {"B", "F", "A", "T", "P", "U"}:
        raise ValueError("Unsupported assay_type")
    if standard_value_max is not None:
        if not standard_type or not standard_units or not standard_relation or not 0 <= standard_value_max < float("inf"):
            raise ValueError("A value ceiling requires standard_type, standard_units, standard_relation, and a finite nonnegative value")
        params["standard_value__lte"] = standard_value_max
    if confidence_score_min is not None:
        if not 0 <= confidence_score_min <= 9:
            raise ValueError("confidence_score_min must be between 0 and 9")
    for key, value in (("standard_type", standard_type), ("standard_units", standard_units),
                       ("standard_relation", standard_relation), ("assay_type", assay_type), ("target_organism", target_organism)):
        if value is not None:
            params[key] = value
    data = await _get_json(external_url("data_sources.chembl.activity_api"), params=params)
    assay_ids = sorted({str(item["assay_chembl_id"]) for item in data.get("activities", []) if item.get("assay_chembl_id")})
    assays = {}
    if assay_ids:
        if any(not re.fullmatch(r"CHEMBL\d+", identifier) for identifier in assay_ids):
            raise ValueError("Invalid assay identifier returned by ChEMBL")
        metadata = await _get_json(external_url("data_sources.chembl.assay_api"),
                                   params={"assay_chembl_id__in": ",".join(assay_ids), "limit": 25})
        assays = {item["assay_chembl_id"]: item for item in metadata.get("assays", [])}
    for item in data.get("activities", []):
        item["assay_metadata"] = assays.get(item.get("assay_chembl_id"))
    result = _chembl_result("search_activities", "activity", data, offset, limit)
    if confidence_score_min is not None:
        if any(item["assay_metadata"] is None for item in data.get("activities", [])):
            raise ValueError("Cannot apply the confidence filter: ChEMBL did not return metadata for every assay")
        result["records"] = [record for record in result["records"]
                             if record["structuredData"]["assay_metadata"].get("confidence_score", -1) >= confidence_score_min]
        result["data"]["pagination"]["scanned"] = len(data.get("activities", []))
        result["data"]["pagination"]["returned"] = len(result["records"])
        result["warnings"].append("Confidence is filtered locally per provider page; nextOffset advances over scanned activities, including rejected rows.")
    result["data"]["filters"] = {key: value for key, value in params.items() if key not in {"limit", "offset"}}
    if confidence_score_min is not None:
        result["data"]["filters"]["confidence_score_min"] = confidence_score_min
    return result


@SERVER.tool()
async def chembl_similarity_search(smiles: str, similarity: int = 70, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Search ChEMBL molecules by SMILES similarity."""
    _page(limit, offset)
    if not 40 <= similarity <= 100:
        raise ValueError("similarity must be between 40 and 100")
    data = await _get_json(
        format_external_url(
            "data_sources.chembl.similarity_template",
            smiles=quote(smiles, safe=""),
            similarity=similarity,
        ),
        params={"limit": limit, "offset": offset},
    )
    return _chembl_result("similarity_search", "molecule", data, offset, limit)


# GEO


def _geo_record(item: dict[str, Any]) -> dict[str, Any]:
    accession = str(item.get("accession") or item.get("gse") or item.get("uid") or "")
    title = html.unescape(str(item.get("title") or f"GEO {accession}"))
    return _record(
        "geo", accession, title,
        format_external_url("data_sources.ncbi.geo_accession_template", accession=quote(accession)),
        item, abstract=html.unescape(str(item.get("summary", ""))) or None, scope="metadata",
    )


def _geo_paths(accession: str) -> tuple[str, str, str]:
    normalized = accession.upper()
    if not re.fullmatch(r"GSE\d+", normalized):
        raise ValueError("accession must be a GEO Series identifier such as GSE1000")
    bucket = f"GSE{normalized[3:][:-3]}nnn"
    base = format_external_url(
        "data_sources.ncbi.geo_series_template", bucket=bucket, accession=normalized
    )
    return normalized, f"{base}/matrix/{normalized}_series_matrix.txt.gz", f"{base}/soft/{normalized}_family.soft.gz"


@SERVER.tool()
async def geo_search_studies(query: str, limit: int = 5) -> dict[str, Any]:
    """Search GEO Series and DataSets."""
    ids = await _entrez_search("gds", f"({query}) AND (gse[ETYP] OR gds[ETYP])", limit)
    return _result("geo", "search_studies", [_geo_record(item) for item in await _entrez_summary("gds", ids)],
                   warnings=["Search returns at most the requested limit; refine the query to retrieve other studies."])


async def _geo_miniml(accession: str, target: str = "self") -> ET.Element:
    accession = accession.upper()
    if not re.fullmatch(r"(?:GSE|GSM|GPL|GDS)\d+", accession):
        raise ValueError("accession must be a GEO accession")
    xml = await _get_text(
        format_external_url("data_sources.ncbi.geo_accession_template", accession=accession),
        params={"acc": accession, "targ": target, "form": "xml", "view": "quick"}, accept="application/xml",
    )
    if len(xml.encode()) > 4_000_000:
        raise ValueError("GEO metadata exceeds the supported size; retrieve the family SOFT artifact instead")
    root = ET.fromstring(xml)
    for element in root.iter():
        element.tag = element.tag.rsplit("}", 1)[-1]
    if root.tag != "MINiML":
        raise ValueError("GEO did not return a MINiML record")
    return root


def _geo_miniml_record(node: ET.Element) -> dict[str, Any]:
    identifier = node.get("iid") or node.findtext("Accession") or ""
    record = _record("geo", identifier, node.findtext("Title") or identifier,
                     format_external_url("data_sources.ncbi.geo_accession_template", accession=identifier),
                     {"recordType": node.tag, "metadata": _xml_data(node)}, scope="metadata",
                     warnings=["Expression values require inspection: processed/normalized intensities are not raw RNA-seq counts."])
    return _version(record, node.findtext("Status/Last-Update-Date"))


@SERVER.tool()
async def geo_lookup_accession(accession: str) -> dict[str, Any]:
    """Retrieve GEO Series, Sample, or Platform MINiML metadata (DataSets use Entrez)."""
    accession = accession.upper()
    if accession.startswith("GDS") and re.fullmatch(r"GDS\d+", accession):
        ids = await _entrez_search("gds", f"{accession}[ACCN] AND gds[ETYP]", 1)
        return _result("geo", "lookup_accession", [_geo_record(item) for item in await _entrez_summary("gds", ids)])
    root = await _geo_miniml(accession)
    nodes = [node for node in root if node.get("iid") == accession and node.find("Title") is not None]
    return _result("geo", "lookup_accession", [_geo_miniml_record(node) for node in nodes],
                   warnings=[] if nodes else ["No GEO metadata was returned for this accession."])


@SERVER.tool()
async def geo_get_samples(accession: str, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Retrieve a page of sample conditions, organisms, processing and platform annotations for a Series."""
    _page(limit, offset)
    if limit > 5:
        raise ValueError("Sample metadata pages are limited to 5 samples; continue with nextOffset")
    _geo_paths(accession)
    root = await _geo_miniml(accession)
    identifiers = list(dict.fromkeys(node.get("iid") for node in root.findall("Sample") if node.get("iid")))
    selected = identifiers[offset:offset + limit]
    records = []
    for identifier in selected:
        sample_root = await _geo_miniml(identifier)
        sample = next((node for node in sample_root.findall("Sample") if node.get("iid") == identifier and node.find("Title") is not None), None)
        if sample is None:
            raise ValueError(f"GEO did not return metadata for {identifier}")
        records.append(_geo_miniml_record(sample))
    page = _pagination(len(identifiers), offset, len(selected), limit)
    return _result("geo", "get_samples", records,
                   data={"seriesAccession": accession.upper(), "pagination": page},
                   warnings=["Only this page of samples is returned; continue with nextOffset."] if page["hasMore"] else [])


class _GeoLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self.links.extend(value for key, value in attrs if key == "href" and value)


async def _geo_files(accession: str) -> tuple[str, list[dict[str, str]], list[str]]:
    normalized, matrix, _ = _geo_paths(accession)
    base = matrix.rsplit("/matrix/", 1)[0] + "/"
    files = []
    warnings = []
    for folder, kind in (("matrix", "series-matrix"), ("soft", "soft"), ("suppl", "supplementary")):
        directory = f"{base}{folder}/"
        try:
            listing = await _get_text(directory, accept="text/html")
        except RuntimeError as error:
            if str(error).startswith("HTTP 404 "):
                warnings.append(f"No {folder} directory is available for {normalized}.")
                continue
            raise
        if len(listing.encode()) > 1_000_000:
            raise ValueError("GEO file listing exceeds the supported size; browse the provider archive directly")
        parser = _GeoLinks()
        parser.feed(listing)
        for href in parser.links:
            url = urljoin(directory, href)
            parsed = urlsplit(url)
            if not url.startswith(directory) or parsed.query or parsed.fragment:
                continue
            name = unquote(parsed.path.rsplit("/", 1)[-1])
            if not name or "/" in name or "\\" in name or name in {".", ".."}:
                continue
            _provider_file(url, "geo")
            if not any(item["url"] == url for item in files):
                files.append({"file_name": name, "format": kind, "url": url})
    return normalized, files, warnings


@SERVER.tool()
async def geo_list_files(accession: str, limit: int = 5, offset: int = 0) -> dict[str, Any]:
    """Discover actual Series matrix, SOFT and supplementary files from NCBI directory listings."""
    _page(limit, offset)
    normalized, files, warnings = await _geo_files(accession)
    selected = files[offset:offset + limit]
    page = _pagination(len(files), offset, len(selected), limit)
    return _result("geo", "list_files", [], data={
        "accession": normalized,
        "files": selected, "pagination": page,
    }, warnings=warnings + (["Only this page of files is returned; continue with nextOffset."] if page["hasMore"] else []))


@SERVER.tool()
async def geo_prepare_dataset_download(accession: str, format: str = "series-matrix", file_name: str | None = None) -> dict[str, Any]:
    """Prepare one discovered GEO file, with explicit file selection for multi-platform studies."""
    if format not in {"series-matrix", "soft", "supplementary"}:
        raise ValueError("format must be series-matrix, soft, or supplementary")
    normalized, files, warnings = await _geo_files(accession)
    selected = [item for item in files if item["format"] == format and (file_name is None or item["file_name"] == file_name)]
    if len(selected) != 1:
        raise ValueError("Select one available file_name from geo_list_files for the requested format")
    url = selected[0]["url"]
    name = selected[0]["file_name"]
    return _result("geo", "prepare_dataset_download", [], artifacts=[{
        "attribution": "Functional genomics file provided by NCBI GEO.",
        "format": "txt.gz" if format == "series-matrix" else name.split(".", 1)[-1],
        "id": f"geo:{normalized}:{format}:{name}",
        "kind": "expression-matrix" if format == "series-matrix" else "dataset",
        "license": "NCBI data usage policy",
        "logicalName": name,
        "mimeType": "application/gzip" if name.endswith(".gz") else "application/octet-stream",
        "sourceId": "geo",
        "sourceRecordId": normalized,
        "sourceUrl": url,
    }], warnings=warnings + ["Download asynchronously, verify the artifact, then inspect data type and sample design before analysis."])


def main() -> None:
    SERVER.run(transport="stdio")


if __name__ == "__main__":
    main()
