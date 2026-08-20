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


def main() -> None:
    SERVER.run(transport="stdio")


if __name__ == "__main__":
    main()
