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

"""Small stdio MCP server for governed UniProtKB discovery.

The server only performs provider-facing queries and returns structured,
source-native candidates. Node remains responsible for permission, caching,
normalization, audit, citation policy, and artifact byte transfer.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

from .external_urls import external_url, format_external_url

SERVER = FastMCP("uniprot")
BASE_URL = external_url("data_sources.uniprot.api_base")
FIELDS = "accession,id,reviewed,protein_name,gene_names,organism_name,length,cc_function,cc_disease,lit_pubmed_id"
ACCESSION = re.compile(r"^[A-Z0-9][A-Z0-9-]{4,19}$", re.IGNORECASE)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _raise_for_status(response: httpx.Response) -> None:
    """Readable status error that keeps the Retry-After hint for the retry loop."""
    if response.status_code < 400:
        return
    message = f"HTTP {response.status_code} {response.reason_phrase} from {response.request.url.host}"
    retry_after = response.headers.get("retry-after")
    if retry_after:
        message += f" (retry-after: {retry_after})"
    raise RuntimeError(message)


def _citation(accession: str, title: str) -> dict[str, Any]:
    url = format_external_url("data_sources.uniprot.entry_template", accession=accession)
    return {
        "identifier": accession,
        "identifierType": "UniProt accession",
        "label": f"UniProtKB {accession}: {title}",
        "markdown": f"[UniProt:{accession}]({url})",
        "role": "database-record",
        "source": "uniprot",
        "url": url,
    }


def _parse_tsv(body: str) -> list[dict[str, Any]]:
    lines = [line for line in body.splitlines() if line]
    if len(lines) < 2:
        return []
    headers = lines[0].split("\t")
    records: list[dict[str, Any]] = []
    for line in lines[1:]:
        cells = line.split("\t")
        values = {
            name: cells[index].strip() if index < len(cells) else ""
            for index, name in enumerate(headers)
        }
        accession = values.get("Entry", "")
        if not accession:
            continue
        title = values.get("Protein names") or values.get("Entry Name") or f"UniProtKB {accession}"
        citation = _citation(accession, title)
        records.append({
            "authors": [],
            "citations": [citation],
            "contentScope": "curated-record",
            "crossReferences": [],
            "fullTextRetrieved": False,
            "identifier": accession,
            "identifierType": "UniProt accession",
            "peerReviewStatus": "not-applicable",
            "primaryCitation": citation,
            "source": "uniprot",
            "structuredData": {
                "disease": values.get("Involvement in disease", "")[:2_000],
                "function": values.get("Function [CC]", "")[:2_000],
                "geneNames": values.get("Gene Names", ""),
                "length": values.get("Length", ""),
                "organism": values.get("Organism", ""),
                "pubmedIds": values.get("PubMed ID", "")[:2_000],
                "reviewed": values.get("Reviewed", ""),
            },
            "title": title,
            "url": citation["url"],
            "warnings": [],
        })
    return records


async def _query(query: str, limit: int) -> dict[str, Any]:
    if not query.strip():
        raise ValueError("query must not be empty")
    if limit < 1 or limit > 25:
        raise ValueError("limit must be between 1 and 25")
    async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
        response = await client.get(
            f"{BASE_URL}/uniprotkb/search",
            params={
                "fields": FIELDS,
                "format": "tsv",
                "query": query,
                "size": str(limit),
            },
            headers={"accept": "text/tab-separated-values"},
        )
        _raise_for_status(response)
    release = response.headers.get("x-uniprot-release")
    records = _parse_tsv(response.text)
    if release:
        for record in records:
            for citation in record["citations"]:
                citation["sourceVersion"] = release
            record["primaryCitation"]["sourceVersion"] = release
    return {
        "attribution": "Protein annotations provided by the UniProt Consortium.",
        "license": "UniProt terms of use",
        "records": records,
        "retrievedAt": _now(),
        "sourceId": "uniprot",
        **({"sourceVersion": release} if release else {}),
        "toolId": "search",
        "untrusted": True,
        "warnings": [],
    }


@SERVER.tool()
async def search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search UniProtKB for proteins, genes, organisms, functions, or diseases."""
    return await _query(query, limit)


@SERVER.tool()
async def lookup(accession: str) -> dict[str, Any]:
    """Look up one canonical UniProtKB accession."""
    normalized = accession.strip().upper()
    if not ACCESSION.fullmatch(normalized):
        raise ValueError("accession has an invalid UniProtKB format")
    result = await _query(f"accession:{normalized}", 1)
    result["toolId"] = "lookup"
    return result


@SERVER.tool()
async def prepare_sequence(accession: str, format: str = "fasta") -> dict[str, Any]:
    """Prepare a governed sequence artifact candidate; this does not download bytes."""
    normalized = accession.strip().upper()
    if not ACCESSION.fullmatch(normalized):
        raise ValueError("accession has an invalid UniProtKB format")
    if format not in {"fasta", "txt"}:
        raise ValueError("format must be fasta or txt")
    suffix = "fasta" if format == "fasta" else "txt"
    return {
        "artifacts": [{
            "attribution": "Protein sequence provided by the UniProt Consortium.",
            "format": suffix,
            "id": f"uniprot:{normalized}:{suffix}",
            "kind": "sequence",
            "license": "UniProt terms of use",
            "logicalName": f"{normalized}.{suffix}",
            "mimeType": "text/plain",
            "sourceId": "uniprot",
            "sourceRecordId": normalized,
            "sourceUrl": f"{BASE_URL}/uniprotkb/{normalized}.{suffix}",
        }],
        "attribution": "Protein sequence provided by the UniProt Consortium.",
        "license": "UniProt terms of use",
        "records": [],
        "retrievedAt": _now(),
        "sourceId": "uniprot",
        "toolId": "prepare_sequence",
        "untrusted": True,
        "warnings": ["The sequence file is a download candidate and has not been read yet."],
    }


def main() -> None:
    SERVER.run(transport="stdio")


if __name__ == "__main__":
    main()
