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
import os
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx
from mcp.server.fastmcp import FastMCP

from .external_urls import external_url, format_external_url

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


async def _get_json(url: str, *, params: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        response = await client.get(url, params=params, headers={"accept": "application/json"})
        _raise_for_status(response)
        return response.json()


async def _post_json(url: str, *, json_body: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        response = await client.post(url, json=json_body, headers={"accept": "application/json"})
        _raise_for_status(response)
        return response.json()


async def _get_text(url: str, *, params: dict[str, Any] | None = None, accept: str = "text/plain") -> str:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        response = await client.get(url, params=params, headers={"accept": accept})
        _raise_for_status(response)
        return response.text


async def _post_json(url: str, payload: Any) -> Any:
    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        response = await client.post(url, json=payload, headers={"accept": "application/json"})
        _raise_for_status(response)
        return response.json()


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
    }


# arXiv / PubMed / Europe PMC


def _clean(value: Any, limit: int = 4_000) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


async def _arxiv_search(query: str, limit: int) -> dict[str, Any]:
    payload = await _get_text(
        external_url("data_sources.arxiv.api_query"),
        params={
            "max_results": max(1, min(limit, 25)),
            "search_query": query if ":" in query else f"all:{query}",
            "start": 0,
        },
        accept="application/atom+xml",
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
    return _record(
        "pdb", pdb_id, title,
        format_external_url("data_sources.rcsb.structure_template", identifier=pdb_id), data,
        scope="curated-record",
        year=str(accession.get("initial_release_date", ""))[:4] or None,
        warnings=[
            f"Experimental method/resolution metadata must be interpreted from the structured record; resolution_combined={info.get('resolution_combined')}."
        ],
    )


@SERVER.tool()
async def pdb_search_structures(query: str, limit: int = 5) -> dict[str, Any]:
    """Full-text search released PDB structures."""
    search = await _post_json(external_url("data_sources.rcsb.search_api"), {
        "query": {"type": "terminal", "service": "full_text", "parameters": {"value": query}},
        "request_options": {"paginate": {"start": 0, "rows": min(limit, 25)}},
        "return_type": "entry",
    })
    records = []
    for hit in search.get("result_set", [])[:limit]:
        pdb_id = str(hit.get("identifier", "")).upper()
        if pdb_id:
            records.append(_pdb_record(pdb_id, await _pdb_entry(pdb_id)))
    return _result("pdb", "search_structures", records)


@SERVER.tool()
async def pdb_lookup_structure(pdb_id: str) -> dict[str, Any]:
    """Look up one PDB structure."""
    normalized = pdb_id.upper()
    return _result("pdb", "lookup_structure", [_pdb_record(normalized, await _pdb_entry(normalized))])


@SERVER.tool()
async def pdb_prepare_structure_download(pdb_id: str, format: str = "cif") -> dict[str, Any]:
    """Prepare an RCSB structure file candidate without downloading bytes."""
    normalized = pdb_id.upper()
    await _pdb_entry(normalized)
    if format not in {"cif", "pdb"}:
        raise ValueError("format must be cif or pdb")
    return _result("pdb", "prepare_structure_download", [], artifacts=[{
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
    ids = await _entrez_search("clinvar", f"{accession}[accn]", 5)
    items = await _entrez_summary("clinvar", ids)
    return _result("clinvar", "lookup_accession", [_clinvar_record(item) for item in items])


@SERVER.tool()
async def clinvar_get_assertions(accession: str) -> dict[str, Any]:
    """Retrieve the full ClinVar XML assertion record."""
    ids = await _entrez_search("clinvar", f"{accession}[accn]", 5)
    xml = await _get_text(
        external_url("data_sources.ncbi.eutils_efetch"),
        params={"db": "clinvar", "id": ",".join(ids), "rettype": "vcv", "retmode": "xml"},
        accept="application/xml",
    ) if ids else ""
    return _result(
        "clinvar", "get_assertions", [],
        data={"accession": accession, "xml": xml[:4_000_000]},
        warnings=["Assertion XML is untrusted source data; preserve individual SCV submissions and review status."],
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
                format_external_url(
                    "data_sources.chembl.explore_template",
                    kind=kind,
                    identifier=identifier.removeprefix("CHEMBL"),
                ),
                item, scope="curated-record",
            ))
    return records


async def _chembl_search(resource: str, query: str, limit: int) -> dict[str, Any]:
    data = await _get_json(
        format_external_url("data_sources.chembl.resource_search_template", resource=resource),
        params={"q": query, "limit": min(limit, 25)},
    )
    plural = {"molecule": "molecules", "target": "targets"}[resource]
    return _result("chembl", f"search_{plural}", _chembl_records(resource, data.get(plural, [])))


@SERVER.tool()
async def chembl_search_molecules(query: str, limit: int = 5) -> dict[str, Any]:
    """Search ChEMBL molecules."""
    return await _chembl_search("molecule", query, limit)


@SERVER.tool()
async def chembl_search_targets(query: str, limit: int = 5) -> dict[str, Any]:
    """Search ChEMBL targets."""
    return await _chembl_search("target", query, limit)


@SERVER.tool()
async def chembl_search_activities(limit: int = 5, molecule_chembl_id: str | None = None, target_chembl_id: str | None = None) -> dict[str, Any]:
    """Search ChEMBL activities by molecule and/or target."""
    params: dict[str, Any] = {"limit": min(limit, 25)}
    if molecule_chembl_id:
        params["molecule_chembl_id"] = molecule_chembl_id
    if target_chembl_id:
        params["target_chembl_id"] = target_chembl_id
    if len(params) == 1:
        raise ValueError("molecule_chembl_id or target_chembl_id is required")
    data = await _get_json(external_url("data_sources.chembl.activity_api"), params=params)
    return _result("chembl", "search_activities", _chembl_records("activity", data.get("activities", [])))


@SERVER.tool()
async def chembl_similarity_search(smiles: str, similarity: int = 70, limit: int = 5) -> dict[str, Any]:
    """Search ChEMBL molecules by SMILES similarity."""
    data = await _get_json(
        format_external_url(
            "data_sources.chembl.similarity_template",
            smiles=quote(smiles, safe=""),
            similarity=similarity,
        ),
        params={"limit": min(limit, 25)},
    )
    return _result("chembl", "similarity_search", _chembl_records("molecule", data.get("molecules", [])))


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
    bucket = f"{normalized[:-3]}nnn"
    base = format_external_url(
        "data_sources.ncbi.geo_series_template", bucket=bucket, accession=normalized
    )
    return normalized, f"{base}/matrix/{normalized}_series_matrix.txt.gz", f"{base}/soft/{normalized}_family.soft.gz"


@SERVER.tool()
async def geo_search_studies(query: str, limit: int = 5) -> dict[str, Any]:
    """Search GEO Series and DataSets."""
    ids = await _entrez_search("gds", f"({query}) AND (gse[ETYP] OR gds[ETYP])", limit)
    return _result("geo", "search_studies", [_geo_record(item) for item in await _entrez_summary("gds", ids)])


@SERVER.tool()
async def geo_lookup_accession(accession: str) -> dict[str, Any]:
    """Look up a GEO accession."""
    record_type = "gse" if accession.upper().startswith("GSE") else "gds"
    ids = await _entrez_search("gds", f"{accession}[ACCN] AND {record_type}[ETYP]", 1)
    return _result("geo", "lookup_accession", [_geo_record(item) for item in await _entrez_summary("gds", ids)])


@SERVER.tool()
async def geo_list_files(accession: str) -> dict[str, Any]:
    """List standard GEO Series matrix and family SOFT file candidates."""
    normalized, matrix, soft = _geo_paths(accession)
    return _result("geo", "list_files", [], data={
        "accession": normalized,
        "files": [{"format": "series-matrix", "url": matrix}, {"format": "soft", "url": soft}],
    }, warnings=["Standard paths are candidates; provider availability is checked during the governed download."])


@SERVER.tool()
async def geo_prepare_dataset_download(accession: str, format: str = "series-matrix") -> dict[str, Any]:
    """Prepare a standard GEO Series matrix or family SOFT candidate."""
    normalized, matrix, soft = _geo_paths(accession)
    if format not in {"series-matrix", "soft"}:
        raise ValueError("format must be series-matrix or soft")
    url = matrix if format == "series-matrix" else soft
    name = url.rsplit("/", 1)[-1]
    return _result("geo", "prepare_dataset_download", [], artifacts=[{
        "attribution": "Functional genomics file provided by NCBI GEO.",
        "format": "txt.gz" if format == "series-matrix" else "soft.gz",
        "id": f"geo:{normalized}:{format}",
        "kind": "expression-matrix" if format == "series-matrix" else "dataset",
        "license": "NCBI data usage policy",
        "logicalName": name,
        "mimeType": "application/gzip",
        "sourceId": "geo",
        "sourceRecordId": normalized,
        "sourceUrl": url,
    }], warnings=["Large GEO files are downloaded asynchronously after explicit permission."])


# PubChem / AlphaFold DB / InterPro / OPTIMADE / STRING / BioGRID
# (Z6 connector expansion, ported from the DeepAnalyze data-connector pack;
# provider-behaviour notes below encode measured API deviations.)


PUBCHEM_PROPERTIES = ",".join([
    "MolecularFormula", "MolecularWeight", "CanonicalSMILES", "IsomericSMILES",
    "IUPACName", "XLogP", "TPSA", "HBondDonorCount", "HBondAcceptorCount",
])


def _pubchem_property_records(payload: dict[str, Any], *, tool: str) -> list[dict[str, Any]]:
    properties = payload.get("PropertyTable", {}).get("Properties", [])
    records = []
    for item in properties[:25]:
        cid = str(item.get("CID") or "")
        if not cid:
            continue
        records.append(_record(
            "pubchem", cid, str(item.get("IUPACName") or f"PubChem CID {cid}"),
            format_external_url("data_sources.pubchem.compound_page_template", cid=cid),
            item, scope="structured-record",
        ))
    return records


@SERVER.tool()
async def pubchem_search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search PubChem compound names and return matching CIDs."""
    if not query.strip():
        raise ValueError("query is required")
    # The name→cids endpoint returns few hits (compound names are near-unique);
    # cap locally instead of passing undocumented upstream parameters.
    data = await _get_json(
        format_external_url("data_sources.pubchem.name_cids_template", name=quote(query.strip(), safe="")),
    )
    cids = [str(cid) for cid in data.get("IdentifierList", {}).get("CID", [])][: max(1, min(limit, 25))]
    return _result(
        "pubchem", "search",
        [
            _record(
                "pubchem", cid, f"PubChem CID {cid}",
                format_external_url("data_sources.pubchem.compound_page_template", cid=cid),
                {"cid": int(cid)}, scope="structured-record",
            )
            for cid in cids
        ],
        warnings=[
            "PubChem aggregates depositor records: the same compound can carry conflicting depositor values; the CID is the stable identity.",
            "Search matches compound names only — resolve SMILES/InChI inputs with pubchem_resolve instead.",
        ],
    )


@SERVER.tool()
async def pubchem_lookup(cid: str) -> dict[str, Any]:
    """Look up one PubChem compound property record by CID."""
    normalized = cid.strip()
    if not re.fullmatch(r"\d{1,9}", normalized):
        raise ValueError("cid must be a numeric PubChem CID")
    payload = await _get_json(format_external_url(
        "data_sources.pubchem.cid_properties_template", cid=normalized, properties=PUBCHEM_PROPERTIES,
    ))
    records = _pubchem_property_records(payload, tool="lookup")
    if not records:
        raise RuntimeError(f"HTTP 404 Not Found from pubchem.ncbi.nlm.nih.gov (CID {normalized})")
    return _result("pubchem", "lookup", records)


@SERVER.tool()
async def pubchem_resolve(value: str, by: str = "name") -> dict[str, Any]:
    """Resolve a compound name, SMILES, or InChI into a PubChem property record."""
    if by not in {"name", "smiles", "inchi"}:
        raise ValueError("by must be name, smiles, or inchi")
    if not value.strip():
        raise ValueError("value is required")
    # SMILES/InChI carry slashes, parentheses, and colons — encode everything.
    payload = await _get_json(format_external_url(
        "data_sources.pubchem.resolve_properties_template",
        namespace=by, value=quote(value.strip(), safe=""), properties=PUBCHEM_PROPERTIES,
    ))
    records = _pubchem_property_records(payload, tool="resolve")
    if not records:
        raise RuntimeError(f"HTTP 404 Not Found from pubchem.ncbi.nlm.nih.gov (no compound for the given {by})")
    return _result(
        "pubchem", "resolve", records[:1],
        warnings=["Resolution returns the best-matching deposit; ambiguous identifiers may need pubchem_search."],
    )


@SERVER.tool()
async def afdb_lookup(uniprot_acc: str) -> dict[str, Any]:
    """Look up AlphaFold predicted structures for a UniProt accession."""
    accession = uniprot_acc.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{6,10}", accession):
        raise ValueError("uniprot_acc must be a UniProt accession such as P12345")
    predictions_raw = await _get_json(format_external_url(
        "data_sources.afdb.prediction_template", accession=accession,
    ))
    predictions = []
    for item in predictions_raw if isinstance(predictions_raw, list) else []:
        # AFDB fragment records have no sequenceLength field — derive it from
        # the covered interval instead of reporting it as absent.
        start, end = item.get("uniprotStart"), item.get("uniprotEnd")
        predictions.append({
            "entryId": item.get("entryId"),
            "uniprotAccession": item.get("uniprotAccession"),
            "gene": item.get("gene"),
            "organism": item.get("organismScientificName"),
            "sequenceLength": end - start + 1 if isinstance(start, int) and isinstance(end, int) else None,
            "meanPlddt": item.get("confidenceScore"),
            "fractionVeryHighConfidence": item.get("fractionPlddtVeryHigh"),
            "cifUrl": item.get("cifUrl"),
            "pdbUrl": item.get("pdbUrl"),
            "paeUrl": item.get("paeDocUrl"),
            "modelVersion": item.get("latestVersion"),
        })
    if not predictions:
        raise RuntimeError(f"HTTP 404 Not Found from alphafold.ebi.ac.uk (no prediction for {accession})")
    gene = next((str(p["gene"]) for p in predictions if p.get("gene")), accession)
    return _result(
        "afdb", "lookup",
        [
            _record(
                "afdb", accession, f"AlphaFold prediction for {gene}",
                format_external_url("data_sources.afdb.entry_page_template", accession=accession),
                {"predictions": predictions}, scope="structured-record",
                warnings=[
                    "Predicted structures are not experimentally determined: mean pLDDT >70 is trustworthy, <50 is usually a disordered region.",
                    "For experimental structures prefer the PDB source.",
                    "Model file links (cifUrl/pdbUrl/paeUrl) are passed through from the upstream payload verbatim; the connector URL allowlist only governs the record landing page.",
                ],
            )
        ],
    )


@SERVER.tool()
async def interpro_lookup_entry(accession: str) -> dict[str, Any]:
    """Look up one InterPro protein family or domain entry (IPR or legacy Pfam accession)."""
    normalized = accession.strip().upper()
    if not re.fullmatch(r"(IPR|PF)\d{4,8}", normalized):
        raise ValueError("accession must be an InterPro entry such as IPR000719 or a Pfam signature such as PF00069")
    # Pfam was folded into InterPro in 2022 (pfam.xfam.org is retired) — Pfam
    # signatures are served from the same API under the pfam database.
    database = "pfam" if normalized.startswith("PF") else "interpro"
    data = await _get_json(format_external_url(
        "data_sources.interpro.entry_api_template", database=database, accession=normalized,
    ), params={"format": "json"})
    metadata = data.get("metadata", {})
    description = metadata.get("description") or []
    first_text = description[0].get("text") if description and isinstance(description[0], dict) else None
    title = str(metadata.get("name") or normalized)
    return _result(
        "interpro", "lookup_entry",
        [
            _record(
                "interpro", normalized, title,
                format_external_url(
                    "data_sources.interpro.entry_page_template", database=database, accession=normalized,
                ),
                {
                    "accession": metadata.get("accession"),
                    "name": metadata.get("name") if isinstance(metadata.get("name"), str) else None,
                    "type": metadata.get("type"),
                    "sourceDatabase": metadata.get("source_database"),
                    # Entry descriptions arrive as embedded HTML — strip tags
                    # before the text enters model context.
                    "description": re.sub(r"<[^>]+>", "", str(first_text))[:1_000] if first_text else None,
                },
                scope="curated-record",
            )
        ],
    )


@SERVER.tool()
async def interpro_protein_entries(uniprot_acc: str, limit: int = 5) -> dict[str, Any]:
    """List the InterPro annotations of one UniProt accession."""
    accession = uniprot_acc.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{6,10}", accession):
        raise ValueError("uniprot_acc must be a UniProt accession such as P12345")
    # page_size=50 is the upstream fetch window; records are capped locally.
    data = await _get_json(format_external_url(
        "data_sources.interpro.protein_entry_api_template", accession=accession,
    ), params={"format": "json", "page_size": 50})
    records = []
    for entry in (data.get("results") or [])[: max(1, min(limit, 25))]:
        metadata = entry.get("metadata", {})
        identifier = str(metadata.get("accession") or "")
        if not identifier:
            continue
        name = metadata.get("name") if isinstance(metadata.get("name"), str) else None
        records.append(_record(
            "interpro", identifier, str(name or identifier),
            format_external_url(
                "data_sources.interpro.entry_page_template", database="interpro", accession=identifier,
            ),
            {
                "accession": metadata.get("accession"),
                "name": name,
                "type": metadata.get("type"),
                "sourceDatabase": metadata.get("source_database"),
            },
            scope="curated-record",
        ))
    return _result(
        "interpro", "protein_entries", records,
        data={"uniprotAccession": accession, "count": data.get("count")},
    )


OPTIMADE_PROVIDERS: dict[str, dict[str, str]] = {
    "oqmd": {
        "label": "OQMD",
        "api": "data_sources.optimade.oqmd_structures_template",
        "page": "data_sources.optimade.oqmd_materials_page",
    },
    "aflow": {
        "label": "AFLOW",
        "api": "data_sources.optimade.aflow_structures_template",
        "page": "data_sources.optimade.aflow_home_page",
    },
    "cod": {
        "label": "COD",
        "api": "data_sources.optimade.cod_structures_template",
        "page": "data_sources.optimade.cod_entry_page_template",
    },
    "mp": {
        "label": "Materials Project",
        "api": "data_sources.optimade.mp_structures_template",
        "page": "data_sources.optimade.mp_entry_page_template",
    },
}


def _optimade_filter(filter_: str | None, formula: str | None, elements: str | None) -> str:
    """Compose an OPTIMADE filter from a raw filter, reduced formula, or element list."""
    raw = (filter_ or "").strip()
    if raw:
        return raw
    if formula and formula.strip():
        return f'chemical_formula_reduced="{formula.strip()}"'
    if elements and elements.strip():
        quoted = ",".join(f'"{element.strip()}"' for element in elements.split(",") if element.strip())
        return f"elements HAS ALL {quoted}"
    raise ValueError("provide one of filter, formula, or elements")


@SERVER.tool()
async def optimade_query_structures(
    filter: str | None = None, formula: str | None = None, elements: str | None = None,
    provider: str = "oqmd", limit: int = 10,
) -> dict[str, Any]:
    """Query crystal structures across OPTIMADE providers (OQMD, AFLOW, COD, Materials Project)."""
    if provider not in OPTIMADE_PROVIDERS:
        raise ValueError(f"unknown provider {provider!r} — available: " + ", ".join(sorted(OPTIMADE_PROVIDERS)))
    composed = _optimade_filter(filter, formula, elements)
    definition = OPTIMADE_PROVIDERS[provider]
    capped = max(1, min(limit, 25))
    data = await _get_json(external_url(definition["api"]), params={
        "filter": composed,
        "page_limit": capped,
        "response_fields": "chemical_formula_reduced,elements,nelements,nsites,structure_features",
        "response_format": "json",
    })
    # Some providers ignore page_limit (measured on OQMD) — truncate here.
    structures = []
    for item in (data.get("data") or [])[:capped]:
        attributes = item.get("attributes") or {}
        identifier = str(item.get("id") or "")
        if not identifier:
            continue
        formula_value = attributes.get("chemical_formula_reduced")
        if provider == "cod":
            page_url = format_external_url(definition["page"], identifier=quote(identifier, safe=""))
        elif provider == "mp":
            page_url = format_external_url(definition["page"], identifier=quote(identifier, safe=""))
        else:
            # OQMD and AFLOW expose no stable per-entry public page — cite the
            # provider's materials browser and keep the entry id in the record.
            page_url = external_url(definition["page"])
        structures.append(_record(
            "optimade", f"{provider}:{identifier}",
            f"{definition['label']} {identifier}: {formula_value or 'structure'}",
            page_url,
            {
                "provider": definition["label"],
                "entryId": identifier,
                "formula": formula_value,
                "elements": attributes.get("elements") or [],
                "nelements": attributes.get("nelements"),
                "nsites": attributes.get("nsites"),
            },
            scope="structured-record",
        ))
    meta = data.get("meta") or {}
    return _result(
        "optimade", "query_structures", structures,
        data={"provider": definition["label"], "returned": len(structures), "available": meta.get("data_available")},
        warnings=[
            "Providers do not uniformly honor page limits — results are truncated locally.",
            "Prefer COD for experimental crystal structures and OQMD/Materials Project for DFT-computed ones; proprietary databases (CSD/ICSD) are out of scope.",
        ],
    )


def _string_confidence(score: float) -> str:
    if score >= 0.7:
        return "high"
    if score >= 0.4:
        return "medium"
    return "low"


@SERVER.tool()
async def string_network(proteins: str, species: int = 9606, limit: int = 10) -> dict[str, Any]:
    """Retrieve protein-interaction network edges for a set of protein identifiers."""
    identifiers = proteins.strip()
    if not identifiers:
        raise ValueError("proteins is required")
    edges = await _get_json(external_url("data_sources.string.network_api"), params={
        "identifiers": identifiers,
        "species": species,
        "limit": max(1, min(limit, 25)),
    })
    records = []
    for edge in edges if isinstance(edges, list) else []:
        protein_a, protein_b = edge.get("preferredName_A"), edge.get("preferredName_B")
        if not protein_a or not protein_b:
            continue
        score = edge.get("score")
        records.append(_record(
            "string", f"{protein_a}__{protein_b}", f"{protein_a} – {protein_b} interaction",
            format_external_url(
                "data_sources.string.network_page_template",
                taxon=species, identifiers=quote(identifiers, safe=",").replace(",", "%0d"),
            ),
            {
                "proteinA": protein_a,
                "proteinB": protein_b,
                # STRING reports scores in [0, 1]; the convention elsewhere is 0-1000.
                "combinedScore": round(score * 1_000) if isinstance(score, (int, float)) else None,
                "confidence": _string_confidence(score) if isinstance(score, (int, float)) else None,
                "ncbiTaxonId": edge.get("ncbiTaxonId"),
            },
            scope="structured-record",
        ))
    return _result(
        "string", "network", records[: max(1, min(limit, 25))],
        warnings=[
            "Combined scores integrate experimental and predicted evidence (0-1000; >=700 is high confidence).",
            "Predicted interactions need experimental review before being treated as established.",
        ],
    )


@SERVER.tool()
async def string_resolve(name: str, species: int = 9606) -> dict[str, Any]:
    """Resolve a protein name to its STRING identifier."""
    identifier = name.strip()
    if not identifier:
        raise ValueError("name is required")
    matches = await _get_json(external_url("data_sources.string.resolve_api"), params={
        "identifiers": identifier,
        "species": species,
        "limit": 5,
    })
    records = []
    for match in matches if isinstance(matches, list) else []:
        string_id, preferred = match.get("stringId"), match.get("preferredName")
        if not string_id or not preferred:
            continue
        records.append(_record(
            "string", str(string_id), str(preferred),
            format_external_url(
                "data_sources.string.network_page_template",
                taxon=species, identifiers=quote(str(preferred), safe=""),
            ),
            {
                "stringId": string_id,
                "name": preferred,
                "annotation": str(match.get("annotation") or "")[:200] or None,
            },
            scope="structured-record",
        ))
    return _result("string", "resolve", records)


@SERVER.tool()
async def biogrid_interactions(gene: str, taxon_id: int = 9606, limit: int = 20) -> dict[str, Any]:
    """Look up manually curated experimental interactions for a gene."""
    name = gene.strip()
    if not name:
        raise ValueError("gene is required")
    access_key = os.environ.get("BIOGRID_API_KEY", "").strip()
    if not access_key:
        raise RuntimeError(
            "BioGRID requires the BIOGRID_API_KEY environment variable (unauthorized)"
        )
    payload = await _get_json(external_url("data_sources.biogrid.interactions_api"), params={
        "searchNames": "true",
        "geneList": name,
        "taxonId": taxon_id,
        "max": max(1, min(limit, 25)),
        "format": "json",
        "accesskey": access_key,
    })
    # BioGRID's contract is a map keyed by an internal interaction hash, not a
    # list. Any other shape (error body, degraded response) must fail loud —
    # treating it as "no interactions" would report curated data as absent.
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"thebiogrid.org returned an unexpected payload shape ({type(payload).__name__}) "
            f"for gene {name!r}"
        )
    records = []
    degraded_entries = 0
    for entry in payload.values():
        # The hash map can carry non-dict junk entries (error envelopes): skip
        # them but count, so a degraded response is visible instead of an
        # AttributeError or a silent partial success.
        if not isinstance(entry, dict):
            degraded_entries += 1
            continue
        gene_a, gene_b = entry.get("OFFICIAL_SYMBOL_A"), entry.get("OFFICIAL_SYMBOL_B")
        if not gene_a or not gene_b:
            continue
        system = entry.get("EXPERIMENTAL_SYSTEM")
        records.append(_record(
            "biogrid", f"{gene_a}__{gene_b}", f"{gene_a} – {gene_b} ({system or 'interaction'})",
            external_url("data_sources.biogrid.home_page"),
            {
                "geneA": gene_a,
                "geneB": gene_b,
                "experimentalSystem": system,
                "throughput": entry.get("THROUGHPUT"),
                "pubmedId": entry.get("PUBMED_ID"),
            },
            scope="curated-record",
        ))
    warnings = [
        "All BioGRID edges are manually curated experimental interactions; preserve the PubMed evidence identifiers.",
    ]
    if degraded_entries:
        warnings.append(
            f"{degraded_entries} degraded non-record entries were skipped from the response payload."
        )
    return _result("biogrid", "interactions", records[: max(1, min(limit, 25))], warnings=warnings)


# gnomAD / GWAS Catalog / Guide to PHARMACOLOGY / KEGG / PRIDE / Wikidata / DataCite
# (Z6 second tier — ported from the DA adapters with their measured upstream
# deviations kept as English comments.)


@SERVER.tool()
async def gnomad_gene(gene: str, reference_genome: str = "GRCh38") -> dict[str, Any]:
    """Look up gnomAD gene-level constraint metrics (LOF/missense observed/expected)."""
    symbol = re.sub(r"[^A-Za-z0-9-]", "", gene.strip())
    if not symbol:
        raise ValueError("gene is required")
    if reference_genome not in ("GRCh37", "GRCh38"):
        raise ValueError("reference_genome must be GRCh37 or GRCh38")
    payload = await _post_json(external_url("data_sources.gnomad.graphql_api"), json_body={
        # DA-measured: the public API tolerates ~10 req/min — point queries only.
        "query": (
            f'query {{ gene(gene_symbol: "{symbol}", reference_genome: {reference_genome}) '
            "{ gene_id symbol gnomad_constraint { oe_lof oe_mis oe_lof_upper oe_mis_upper } } }"
        ),
    })
    gene_data = ((payload.get("data") or {}).get("gene")) or None
    if not gene_data:
        raise RuntimeError(f"HTTP 404 Not Found from gnomad.broadinstitute.org (no gene {symbol!r})")
    constraint = gene_data.get("gnomad_constraint") or None
    gene_id = gene_data.get("gene_id") or symbol
    return _result("gnomad", "gene", [
        _record(
            "gnomad", str(gene_id), f"gnomAD constraint for {gene_data.get('symbol') or symbol}",
            format_external_url("data_sources.gnomad.gene_page_template", gene_id=gene_id),
            {
                "geneId": gene_id,
                "symbol": gene_data.get("symbol"),
                "constraint": {
                    "oeLof": constraint.get("oe_lof"),
                    "oeMis": constraint.get("oe_mis"),
                    "lofUpper": constraint.get("oe_lof_upper"),
                    "misUpper": constraint.get("oe_mis_upper"),
                } if constraint else None,
            },
            scope="structured-record",
            warnings=["Constraint metrics are intolerance references, not pathogenicity verdicts."],
        ),
    ])


@SERVER.tool()
async def gnomad_variant(variant_id: str, reference_genome: str = "GRCh38") -> dict[str, Any]:
    """Look up gnomAD population allele frequencies for a variant id (chr-pos-ref-alt)."""
    variant = variant_id.strip()
    if not re.fullmatch(r"\d{1,2}[XYM]?-\d+-[ACGT]+-[ACGT]+", variant):
        raise ValueError("variant_id must look like 1-55516888-G-A")
    payload = await _post_json(external_url("data_sources.gnomad.graphql_api"), json_body={
        "query": (
            f'query {{ variant(variantId: "{variant}", dataset: gnomad_r4) '
            "{ variant_id genome { ac an af } exome { ac an af } } }"
        ),
    })
    variant_data = ((payload.get("data") or {}).get("variant")) or None
    if not variant_data:
        raise RuntimeError(f"HTTP 404 Not Found from gnomad.broadinstitute.org (no variant {variant!r})")
    return _result("gnomad", "variant", [
        _record(
            "gnomad", variant, f"gnomAD frequencies for {variant}",
            format_external_url("data_sources.gnomad.variant_page_template", variant_id=quote(variant, safe="")),
            {"variantId": variant_data.get("variant_id"), "genome": variant_data.get("genome"), "exome": variant_data.get("exome")},
            scope="structured-record",
            warnings=["Allele frequencies are population references, not pathogenicity verdicts."],
        ),
    ])


def _gwas_association_records(associations: list[dict[str, Any]], query_value: str) -> list[dict[str, Any]]:
    search_page = format_external_url(
        "data_sources.gwas.search_page_template", query=quote(query_value, safe=""),
    )
    records = []
    for index, association in enumerate(associations, start=1):
        snp_alleles = association.get("snp_allele") or []
        rs_id = snp_alleles[0].get("rs_id") if snp_alleles and isinstance(snp_alleles[0], dict) else None
        identifier = str(rs_id or f"assoc-{index}")
        mapped_genes = association.get("mapped_genes") or []
        genes = ",".join(
            str(gene.get("gene_name") if isinstance(gene, dict) else gene)
            for gene in mapped_genes if (gene.get("gene_name") if isinstance(gene, dict) else gene)
        ) or None
        reported = "; ".join(str(t) for t in (association.get("reported_trait") or []) if t)
        traits = "; ".join(
            str(t.get("efo_trait")) for t in (association.get("efo_traits") or [])
            if isinstance(t, dict) and t.get("efo_trait")
        )
        beta = association.get("beta")
        records.append(_record(
            "gwas", identifier, f"GWAS association {identifier}",
            search_page,
            {
                "riskAllele": (association.get("snp_effect_allele") or [None])[0] or (
                    f"{snp_alleles[0].get('rs_id')}-{snp_alleles[0].get('effect_allele')}" if snp_alleles and isinstance(snp_alleles[0], dict) else None
                ),
                "gene": genes,
                "trait": reported or traits or None,
                "pvalue": association.get("p_value"),
                "riskFrequency": association.get("risk_frequency"),
                "beta": None if beta == "-" else beta,
                "pubmedId": association.get("pubmed_id"),
                "firstAuthor": association.get("first_author"),
            },
            scope="structured-record",
            warnings=["Association is not causation: verify ancestry and model in the cited publication."],
        ))
    return records


@SERVER.tool()
async def gwas_search_trait(trait: str, limit: int = 20) -> dict[str, Any]:
    """Search NHGRI-EBI GWAS Catalog SNP-trait associations by trait name.

    The v2 API matches the EFO trait label EXACTLY (case-insensitive):
    \"type 2 diabetes mellitus\" matches, \"type 2 diabetes\" does not.
    """
    value = trait.strip()
    if not value:
        raise ValueError("trait is required")
    # DA-measured (2026-08-31): the v1 findBy* endpoints retired with 404 —
    # only the v2 associations endpoint remains, envelope _embedded.associations.
    payload = await _get_json(external_url("data_sources.gwas.associations_api"), params={
        "efo_trait": value,
        "size": max(1, min(limit, 50)),
    })
    associations = ((payload.get("_embedded") or {}).get("associations")) or []
    records = _gwas_association_records(associations, value)[: max(1, min(limit, 50))]
    # Measured live (2026-09-12 smoke): efo_trait is exact-label match with no
    # server-side search — a near-miss phrasing returns an empty page that
    # looks like "no evidence". Tell the caller how to retry instead.
    warnings = None
    if not records:
        warnings = [
            f"No associations for efo_trait={value!r}: the GWAS v2 API matches the EFO label "
            "exactly (case-insensitive) and has no partial search. Retry with the canonical "
            "EFO label, e.g. 'type 2 diabetes mellitus', 'coronary artery disease', "
            "'body mass index'.",
        ]
    return _result("gwas", "search_trait", records, warnings=warnings)


@SERVER.tool()
async def gwas_search_gene(gene: str, limit: int = 20) -> dict[str, Any]:
    """Search NHGRI-EBI GWAS Catalog associations mapped to a gene."""
    value = gene.strip()
    if not value:
        raise ValueError("gene is required")
    payload = await _get_json(external_url("data_sources.gwas.associations_api"), params={
        "mapped_gene": value,
        "size": max(1, min(limit, 50)),
    })
    associations = ((payload.get("_embedded") or {}).get("associations")) or []
    return _result("gwas", "search_gene", _gwas_association_records(associations, value)[: max(1, min(limit, 50))])


def _gtopdb_decode_entities(value: str) -> str:
    # GtoPdb names carry HTML entities and tags (&beta;<sub>2</sub>).
    replaced = (value
                .replace("&beta;", "β").replace("&alpha;", "α").replace("&gamma;", "γ")
                .replace("&delta;", "δ").replace("&mu;", "μ").replace("&kappa;", "κ")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    return re.sub(r"<[^>]+>", "", re.sub(r"</?(sub|sup)>", "", replaced))


@SERVER.tool()
async def gtopdb_search_target(name: str) -> dict[str, Any]:
    """Search Guide to PHARMACOLOGY targets (receptors, ion channels, enzymes)."""
    value = name.strip()
    if not value:
        raise ValueError("name is required")
    payload = await _get_json(external_url("data_sources.gtopdb.targets_api"), params={"name": value})
    targets = payload if isinstance(payload, list) else []
    return _result("gtopdb", "search_target", [
        _record(
            "gtopdb", str(target.get("targetId")), _gtopdb_decode_entities(str(target.get("name") or "")),
            format_external_url("data_sources.gtopdb.target_page_template", target_id=target.get("targetId")),
            {"targetId": target.get("targetId"), "name": _gtopdb_decode_entities(str(target.get("name") or "")), "type": target.get("type")},
            scope="curated-record",
        )
        for target in targets[:20] if target.get("targetId")
    ], warnings=["CC-BY-SA licensed source: quote results, never persist full records."])


@SERVER.tool()
async def gtopdb_search_ligand(name: str) -> dict[str, Any]:
    """Search Guide to PHARMACOLOGY ligands (drugs, endogenous ligands)."""
    value = name.strip()
    if not value:
        raise ValueError("name is required")
    payload = await _get_json(external_url("data_sources.gtopdb.ligands_api"), params={"name": value})
    ligands = payload if isinstance(payload, list) else []
    return _result("gtopdb", "search_ligand", [
        _record(
            "gtopdb", str(ligand.get("ligandId")), str(ligand.get("name") or ""),
            format_external_url("data_sources.gtopdb.ligand_page_template", ligand_id=ligand.get("ligandId")),
            {"ligandId": ligand.get("ligandId"), "name": ligand.get("name"), "type": ligand.get("type"), "approved": ligand.get("approved")},
            scope="curated-record",
        )
        for ligand in ligands[:20] if ligand.get("ligandId")
    ], warnings=["CC-BY-SA licensed source: quote results, never persist full records."])


@SERVER.tool()
async def gtopdb_interactions(ligand_id: int) -> dict[str, Any]:
    """Look up Guide to PHARMACOLOGY ligand-target interactions (affinity, action)."""
    if not isinstance(ligand_id, int) or ligand_id < 1:
        raise ValueError("ligand_id must be a positive integer")
    payload = await _get_json(format_external_url(
        "data_sources.gtopdb.ligand_interactions_template", ligand_id=ligand_id,
    ))
    interactions = payload if isinstance(payload, list) else []
    if not interactions:
        raise RuntimeError(f"HTTP 404 Not Found from www.guidetopharmacology.org (no interactions for ligand {ligand_id})")
    return _result("gtopdb", "interactions", [
        _record(
            "gtopdb", f"{ligand_id}->{interaction.get('targetId')}",
            f"{interaction.get('targetName')} interaction",
            format_external_url("data_sources.gtopdb.target_page_template", target_id=interaction.get("targetId")),
            {
                "target": interaction.get("targetName"),
                "targetId": interaction.get("targetId"),
                "type": interaction.get("type"),
                "action": interaction.get("action"),
                "affinity": f"{interaction['affinity']} {interaction.get('affinityUnits') or ''}".strip()
                if interaction.get("affinity") is not None else None,
                "endogenous": interaction.get("endogenous"),
            },
            scope="curated-record",
        )
        for interaction in interactions if interaction.get("targetId")
    ])


# KEGG db names: find/link accept the whitelisted libraries plus 3-4 letter
# organism codes. DA-measured (2026-09-01): 'gene'/'organism' both 400 — the
# valid names are 'genes'/'genome'; the frequent-misuse forms are rejected
# with a pointer instead of leaking through the organism-code regex.
KEGG_DB_WHITELIST = (
    "pathway", "compound", "genes", "genome", "ko", "disease", "enzyme", "reaction", "module", "glycan", "drug",
)
KEGG_DB_REJECT_HINTS = {
    "gene": "use 'genes' or an organism code (e.g. hsa) instead of 'gene'",
    "organism": "use 'genome' instead of 'organism'",
}


def _kegg_require_db(value: Any, name: str) -> str:
    db = str(value or "").strip().lower()
    if db in KEGG_DB_REJECT_HINTS:
        raise ValueError(f"{name}: {KEGG_DB_REJECT_HINTS[db]}")
    if db in KEGG_DB_WHITELIST or re.fullmatch(r"[a-z]{3,4}", db):
        return db
    raise ValueError(f"{name} must be a KEGG db ({', '.join(KEGG_DB_WHITELIST)}) or organism code (e.g. hsa)")


def _kegg_parse_tsv(text_value: str) -> list[tuple[str, str]]:
    rows = []
    for line in text_value.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        rows.append((parts[0] or "", (parts[1] if len(parts) > 1 else "").strip()))
    return rows


@SERVER.tool()
async def kegg_find(database: str, query: str) -> dict[str, Any]:
    """Find entries in a KEGG database by keyword (pathway, compound, genes, ko, or organism code)."""
    db = _kegg_require_db(database, "database")
    value = query.strip()
    if not value:
        raise ValueError("query is required")
    text_value = await _get_text(format_external_url(
        "data_sources.kegg.find_template", database=quote(db, safe=""), query=quote(value, safe=""),
    ))
    rows = _kegg_parse_tsv(text_value)
    return _result("kegg", "find", [
        _record(
            "kegg", entry, names or entry,
            format_external_url("data_sources.kegg.entry_page_template", entry=quote(entry, safe=":")),
            {"entry": entry, "names": names},
            scope="structured-record",
        )
        for entry, names in rows[:50]
    ], warnings=["Academic-use source: no bulk scraping; prefer Reactome for cacheable pathway data."])


@SERVER.tool()
async def kegg_get(entry_id: str) -> dict[str, Any]:
    """Get one KEGG flat-file record by entry id (e.g. hsa:10458, C00031), truncated to ~4k chars."""
    entry = entry_id.strip()
    if not re.fullmatch(r"[A-Za-z0-9:_.-]{1,64}", entry):
        raise ValueError("entry_id must look like hsa:10458 / C00031 / hsa04517")
    text_value = await _get_text(format_external_url(
        "data_sources.kegg.get_template", entry=quote(entry, safe=":"),
    ))
    max_chars = 4_000
    return _result("kegg", "get", [
        _record(
            "kegg", entry, f"KEGG entry {entry}",
            format_external_url("data_sources.kegg.entry_page_template", entry=quote(entry, safe=":")),
            {"text": text_value[:max_chars], "truncated": len(text_value) > max_chars, "totalChars": len(text_value)},
            scope="structured-record",
        ),
    ])


@SERVER.tool()
async def kegg_link(source_db: str, target_db: str, id: str) -> dict[str, Any]:
    """Map one KEGG entry across databases (e.g. gene to pathway) via the link endpoint."""
    source = _kegg_require_db(source_db, "source_db")
    target = _kegg_require_db(target_db, "target_db")
    entry = id.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", entry):
        raise ValueError("id is required (e.g. 10458)")
    text_value = await _get_text(format_external_url(
        "data_sources.kegg.link_template",
        target_db=quote(target, safe=""), source=quote(f"{source}:{entry}", safe=":"),
    ))
    rows = _kegg_parse_tsv(text_value)
    return _result("kegg", "link", [
        _record(
            "kegg", mapped, f"{source}:{entry} -> {mapped}",
            format_external_url("data_sources.kegg.entry_page_template", entry=quote(mapped, safe=":")),
            {"source": f"{source}:{entry}", "target": mapped},
            scope="structured-record",
        )
        for _source_entry, mapped in rows[:200]
    ])


def _pride_names_of(list_value: Any) -> list[str]:
    # DA-measured: search/projects returns plain string arrays for
    # organisms/instruments, while /projects/{acc} returns CvParam objects.
    if not isinstance(list_value, list):
        return []
    names = []
    for item in list_value:
        name = item if isinstance(item, str) else (item.get("name") if isinstance(item, dict) else None)
        if name:
            names.append(str(name))
    return names


def _pride_project_summary(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "accession": project.get("accession"),
        "title": project.get("title"),
        "species": _pride_names_of(project.get("organisms")),
        "instruments": _pride_names_of(project.get("instruments")),
        "projectTags": project.get("projectTags"),
        "submissionType": project.get("submissionType"),
        "publicationDate": project.get("publicationDate"),
    }


@SERVER.tool()
async def pride_search_projects(keyword: str, limit: int = 20) -> dict[str, Any]:
    """Search PRIDE Archive proteomics dataset projects by keyword."""
    value = keyword.strip()
    if not value:
        raise ValueError("keyword is required")
    payload = await _get_json(external_url("data_sources.pride.search_projects_api"), params={
        "keyword": value, "page": 0, "pageSize": max(1, min(limit, 50)),
    })
    projects = payload if isinstance(payload, list) else []
    return _result("pride", "search_projects", [
        _record(
            "pride", str(project.get("accession")), str(project.get("title") or project.get("accession")),
            format_external_url("data_sources.pride.project_page_template", accession=project.get("accession")),
            _pride_project_summary(project),
            scope="structured-record",
        )
        for project in projects if project.get("accession")
    ])


@SERVER.tool()
async def pride_project(accession: str) -> dict[str, Any]:
    """Look up one PRIDE project by PXD accession (description, species, instruments, references)."""
    normalized = accession.strip().upper()
    if not re.fullmatch(r"PXD\d{1,9}", normalized):
        raise ValueError("accession must look like PXD000001")
    project = await _get_json(format_external_url(
        "data_sources.pride.project_api_template", accession=normalized,
    ))
    if not isinstance(project, dict) or not project.get("accession"):
        raise RuntimeError(f"HTTP 404 Not Found from www.ebi.ac.uk (no PRIDE project {normalized})")
    references = (project.get("references") or [])[:5]
    return _result("pride", "project", [
        _record(
            "pride", normalized, str(project.get("title") or normalized),
            format_external_url("data_sources.pride.project_page_template", accession=normalized),
            {
                **_pride_project_summary(project),
                "description": _clean(project.get("projectDescription"), 1_000) or None,
                "experimentTypes": [
                    item.get("name") for item in (project.get("experimentTypes") or [])
                    if isinstance(item, dict) and item.get("name")
                ],
                "doi": project.get("doi"),
                "datasetLicense": project.get("license"),
                "references": [
                    {"title": ref.get("referenceLine"), "doi": ref.get("doi"), "pubmedId": ref.get("pubmedID")}
                    for ref in references if isinstance(ref, dict)
                ],
            },
            scope="structured-record",
        ),
    ])


@SERVER.tool()
async def pride_files(accession: str) -> dict[str, Any]:
    """List a PRIDE project's files by PXD accession (metadata only, first 50)."""
    normalized = accession.strip().upper()
    if not re.fullmatch(r"PXD\d{1,9}", normalized):
        raise ValueError("accession must look like PXD000001")
    # DA-measured (2026-09-01): /files/byProject returns 200 with an empty
    # body — the file list must use /projects/{accession}/files. pageSize=51
    # so exactly-50 files do not false-positive the truncated flag.
    payload = await _get_json(format_external_url(
        "data_sources.pride.project_files_api_template", accession=normalized,
    ), params={"page": 0, "pageSize": 51})
    files = payload if isinstance(payload, list) else []
    return _result(
        "pride", "files",
        [
            _record(
                "pride", str(item.get("fileName")), str(item.get("fileName") or ""),
                format_external_url("data_sources.pride.project_page_template", accession=normalized),
                {
                    "fileName": item.get("fileName"),
                    "category": (item.get("fileCategory") or {}).get("value") if isinstance(item.get("fileCategory"), dict) else None,
                    "sizeBytes": item.get("fileSizeBytes"),
                    "checksum": item.get("checksum"),
                    "downloadUrls": [
                        {"protocol": location.get("name"), "url": location.get("value")}
                        for location in (item.get("publicFileLocations") or []) if isinstance(location, dict)
                    ],
                    "publicationDate": item.get("publicationDate"),
                },
                scope="structured-record",
            )
            for item in files[:50] if item.get("fileName")
        ],
        warnings=["Metadata only — download URLs point at upstream FTP/HTTP hosts outside this connector's allowlist."],
    )


@SERVER.tool()
async def wikidata_sparql(query: str, limit: int = 20) -> dict[str, Any]:
    """Run a read-only SPARQL SELECT query against Wikidata (id mapping, entity properties)."""
    value = query.strip()
    if not value:
        raise ValueError("query is required")
    if not re.match(r"^(\s*prefix[\s\S]*?)?\s*select\b", value, re.IGNORECASE) or re.search(
        r"\b(insert|delete|load|clear|create|drop)\b", value, re.IGNORECASE,
    ):
        raise ValueError("only read-only SPARQL SELECT queries are allowed")
    capped = max(1, min(limit, 25))
    limited = value if re.search(r"\blimit\b", value, re.IGNORECASE) else f"{value} LIMIT {capped}"
    payload = await _get_json(external_url("data_sources.wikidata.sparql_endpoint"), params={
        "format": "json", "query": limited,
    })
    bindings = (((payload.get("results") or {}).get("bindings")) or [])
    endpoint = external_url("data_sources.wikidata.sparql_endpoint")
    records = []
    for binding in bindings[:100]:
        row = {key: str(term.get("value")) for key, term in binding.items() if isinstance(term, dict) and term.get("value") is not None}
        first = next(iter(row.values()), "row")
        entity = _entity_of(row.get("item") or row.get("entity") or "")
        url = (format_external_url("data_sources.wikidata.entity_page_template", entity=entity)
               if entity else endpoint)
        records.append(_record("wikidata", entity or first, row.get("itemLabel") or first, url, row, scope="structured-record"))
    return _result("wikidata", "sparql", records, warnings=[
        "Community-edited data: verify critical facts against an authoritative source.",
    ])


@SERVER.tool()
async def wikidata_resolve_entity(name: str, language: str = "en") -> dict[str, Any]:
    """Resolve a name to Wikidata entities (Q ids) in a given language."""
    value = " ".join(name.split())
    if not value:
        raise ValueError("name is required")
    lang = re.sub(r"[^a-z-]", "", language.strip().lower()) or "en"
    escaped = value.replace('"', '\\"')
    sparql = (
        f'SELECT ?item ?itemLabel ?itemDescription WHERE {{ '
        f'?item rdfs:label "{escaped}"@{lang}. '
        f'SERVICE wikibase:label {{ bd:serviceParam wikibase:language "{lang}". }} }} LIMIT 5'
    )
    payload = await _get_json(external_url("data_sources.wikidata.sparql_endpoint"), params={
        "format": "json", "query": sparql,
    })
    bindings = (((payload.get("results") or {}).get("bindings")) or [])
    return _result("wikidata", "resolve_entity", [
        _record(
            "wikidata", entity_id, label or entity_id,
            format_external_url("data_sources.wikidata.entity_page_template", entity=entity_id),
            {"entity": entity_id, "label": label, "description": row.get("itemDescription")},
            scope="structured-record",
        )
        for row in [
            {key: str(term.get("value")) for key, term in binding.items() if isinstance(term, dict) and term.get("value") is not None}
            for binding in bindings
        ]
        for entity_id, label in [(_entity_of(row.get("item")), row.get("itemLabel"))]
        if entity_id
    ])


def _entity_of(item_value: Any) -> str | None:
    value = str(item_value or "")
    match = re.search(r"(Q\d+)$", value)
    return match.group(1) if match else None


@SERVER.tool()
async def datacite_search(query: str, year: int = 0, limit: int = 20) -> dict[str, Any]:
    """Search research datasets across 100+ DataCite repositories by keyword and optional year."""
    value = query.strip()
    if not value:
        raise ValueError("query is required")
    params: dict[str, Any] = {
        "page[size]": max(1, min(limit, 25)),
        "query": value,
        "resource-type-general": "dataset",
    }
    if year:
        if not 1_900 <= year <= 3_000:
            raise ValueError("year must be a plausible publication year")
        params["publicationYear"] = year
    payload = await _get_json(external_url("data_sources.datacite.dois_api"), params=params)
    entries = payload.get("data") or []
    return _result("datacite", "search", [
        _datacite_record(entry) for entry in entries if isinstance(entry, dict)
    ], warnings=["Metadata is CC0; each dataset carries its own license — check before download."])


@SERVER.tool()
async def datacite_lookup(doi: str) -> dict[str, Any]:
    """Look up one dataset's metadata by DOI via DataCite."""
    normalized = doi.strip().replace("https://doi.org/", "")
    if not normalized:
        raise ValueError("doi is required")
    payload = await _get_json(format_external_url(
        "data_sources.datacite.doi_api_template", doi=quote(normalized, safe="/."),
    ))
    entry = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entry, dict):
        raise RuntimeError(f"HTTP 404 Not Found from api.datacite.org (no dataset for DOI {normalized!r})")
    return _result("datacite", "lookup", [_datacite_record(entry)])


def _datacite_record(entry: dict[str, Any]) -> dict[str, Any]:
    attributes = entry.get("attributes") or {}
    doi = str(entry.get("id") or "")
    return _record(
        "datacite", doi,
        str((attributes.get("titles") or [{}])[0].get("title") or doi),
        format_external_url("data_sources.datacite.doi_url_template", doi=quote(doi, safe="/.")),
        {
            "doi": doi,
            "title": (attributes.get("titles") or [{}])[0].get("title"),
            "repository": attributes.get("publisher"),
            "year": attributes.get("publicationYear"),
            "type": ((attributes.get("types") or {}).get("resourceType")
                     or (attributes.get("types") or {}).get("resourceTypeGeneral")),
            "creators": [creator.get("name") for creator in (attributes.get("creators") or [])[:5] if creator.get("name")],
            "url": attributes.get("url"),
            "description": _clean((attributes.get("descriptions") or [{}])[0].get("description"), 500) or None,
        },
        scope="structured-record",
    )


def main() -> None:
    SERVER.run(transport="stdio")


if __name__ == "__main__":
    main()
