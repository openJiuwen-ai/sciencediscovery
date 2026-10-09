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

from __future__ import annotations

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

import json
import os
import socket
import socketserver
import ssl
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from sciencediscovery_gateway.public_biomed_mcp import (
    SERVER,
    _arxiv_search,
    _get_text,
    _pdb_entry,
    _raise_for_status,
    _europe_pmc_search,
    _pmc_pdf_candidate,
    _preprint_prepare_pdf,
    _preprint_search,
    _pubmed_search,
    afdb_lookup,
    biogrid_interactions,
    chembl_search_molecules,
    clinvar_search_variants,
    datacite_lookup,
    datacite_search,
    ensembl_lookup_gene,
    geo_search_studies,
    gnomad_gene,
    gnomad_variant,
    gtopdb_interactions,
    gtopdb_search_target,
    gwas_search_trait,
    interpro_lookup_entry,
    kegg_find,
    kegg_get,
    kegg_link,
    optimade_query_structures,
    pdb_lookup_structure,
    pride_files,
    pride_project,
    pubchem_resolve,
    pubchem_search,
    reactome_lookup_pathway,
    string_network,
    wikidata_resolve_entity,
    wikidata_sparql,
)


PROXY_ENV_NAMES = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)


class _RecordingHandler(BaseHTTPRequestHandler):
    """Answers both origin-form and forward-proxy absolute-form requests."""

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        self.server.seen.append(self.path)  # type: ignore[attr-defined]
        body = json.dumps({"struct": {"title": "CRAMBIN"}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        return


@contextmanager
def _recording_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RecordingHandler)
    server.seen = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def _proxy_environment(**overrides: str):
    """Replace the whole proxy environment, the way the MCP control plane does
    when it spawns this server under a resolved policy."""
    with patch.dict(os.environ, {}, clear=False):
        for name in PROXY_ENV_NAMES:
            os.environ.pop(name, None)
        os.environ.update(overrides)
        yield


def _receive_exactly(connection: socket.socket, count: int) -> bytes:
    chunks = b""
    while len(chunks) < count:
        chunk = connection.recv(count - len(chunks))
        if not chunk:
            raise ConnectionError("SOCKS5 peer closed mid-message")
        chunks += chunk
    return chunks


def _relay(source: socket.socket, destination: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(65536)
            if not chunk:
                break
            destination.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class _Socks5Handler(socketserver.BaseRequestHandler):
    """Minimal RFC 1928 CONNECT with no authentication, tunnelling to one origin.

    Only the domain address type is accepted, which is what a correctly wired
    client sends: the hostname is resolved by the proxy, not locally.
    """

    def handle(self) -> None:
        connection = self.request
        greeting = _receive_exactly(connection, 2)
        _receive_exactly(connection, greeting[1])
        connection.sendall(bytes([0x05, 0x00]))

        header = _receive_exactly(connection, 4)
        if header[1] != 0x01 or header[3] != 0x03:
            connection.sendall(bytes([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            return
        length = _receive_exactly(connection, 1)[0]
        host = _receive_exactly(connection, length).decode("utf-8")
        port = int.from_bytes(_receive_exactly(connection, 2), "big")
        self.server.targets.append(f"{host}:{port}")  # type: ignore[attr-defined]
        connection.sendall(bytes([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))

        with socket.create_connection(self.server.upstream) as upstream:  # type: ignore[attr-defined]
            outbound = threading.Thread(target=_relay, args=(connection, upstream), daemon=True)
            outbound.start()
            _relay(upstream, connection)
            outbound.join(timeout=5)

    def handle_error(self, *args: object) -> None:
        return


@contextmanager
def _socks5_proxy(upstream: tuple[str, int]):
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Socks5Handler)
    server.daemon_threads = True
    server.targets = []  # type: ignore[attr-defined]
    server.upstream = upstream  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class PdbProxyEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    """The Node control plane hands this process a proxy only through the
    environment, so the bundled HTTP clients must keep honouring it. Node's own
    half of the same contract is pinned in
    `services/api/src/mcp/pdb-proxy.test.ts`."""

    async def test_pdb_metadata_request_goes_through_the_injected_proxy(self) -> None:
        with _recording_server() as proxy:
            port = proxy.server_address[1]
            with _proxy_environment(HTTP_PROXY=f"http://127.0.0.1:{port}"):
                with patch(
                    "sciencediscovery_gateway.public_biomed_mcp.format_external_url",
                    return_value="http://data.rcsb.org/rest/v1/core/entry/1CRN",
                ):
                    entry = await _pdb_entry("1crn")
            self.assertEqual(entry["struct"]["title"], "CRAMBIN")
            # Absolute-form request target: the metadata hop crossed the proxy.
            self.assertEqual(proxy.seen, ["http://data.rcsb.org/rest/v1/core/entry/1CRN"])

    async def test_pdb_metadata_request_goes_through_a_socks5_proxy(self) -> None:
        """SOCKS5 needs httpx's `socks` extra; without socksio httpx raises while
        building the client and the request never reaches the proxy."""
        with _recording_server() as origin:
            with _socks5_proxy(("127.0.0.1", origin.server_address[1])) as proxy:
                port = proxy.server_address[1]
                with _proxy_environment(HTTP_PROXY=f"socks5://127.0.0.1:{port}"):
                    with patch(
                        "sciencediscovery_gateway.public_biomed_mcp.format_external_url",
                        return_value="http://data.rcsb.org/rest/v1/core/entry/1CRN",
                    ):
                        entry = await _pdb_entry("1crn")
                self.assertEqual(entry["struct"]["title"], "CRAMBIN")
                # The proxy, not this process, resolved the RCSB hostname.
                self.assertEqual(proxy.targets, ["data.rcsb.org:80"])
            self.assertEqual(origin.seen, ["/rest/v1/core/entry/1CRN"])

    async def test_pdb_metadata_request_stays_direct_without_a_proxy(self) -> None:
        with _recording_server() as proxy, _recording_server() as origin:
            origin_port = origin.server_address[1]
            with _proxy_environment():
                with patch(
                    "sciencediscovery_gateway.public_biomed_mcp.format_external_url",
                    return_value=f"http://127.0.0.1:{origin_port}/rest/v1/core/entry/1CRN",
                ):
                    await _pdb_entry("1CRN")
            self.assertEqual(origin.seen, ["/rest/v1/core/entry/1CRN"])
            self.assertEqual(proxy.seen, [])


class PublicBiomedMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_biorxiv_and_medrxiv_fixtures_preserve_source_and_pdf_host(self) -> None:
        for source in ("biorxiv", "medrxiv"):
            payload = {"collection": [{
                "abstract": "A bounded abstract",
                "authors": "A. Author; B. Author",
                "date": "2026-01-01",
                "doi": "10.1101/2026.01.01.123456",
                "title": f"{source} result",
                "version": "2",
            }]}
            with patch(
                "sciencediscovery_gateway.public_biomed_mcp._get_json",
                new=AsyncMock(return_value=payload),
            ):
                search = await _preprint_search(source, "bounded", 30, 5, None)
                prepared = await _preprint_prepare_pdf(source, "10.1101/2026.01.01.123456", None)
            self.assertEqual(search["sourceId"], source)
            self.assertEqual(search["records"][0]["source"], source)
            self.assertEqual(prepared["artifacts"][0]["sourceId"], source)
            self.assertTrue(
                prepared["artifacts"][0]["sourceUrl"].startswith(f"https://www.{source}.org/")
            )

    async def test_server_registers_the_complete_manifest_tool_set(self) -> None:
        actual = {tool.name for tool in await SERVER.list_tools()}
        self.assertEqual(actual, {
            "afdb_lookup",
            "arxiv_prepare_paper_download", "arxiv_search",
            "biogrid_interactions",
            "biorxiv_lookup_doi", "biorxiv_prepare_paper_download", "biorxiv_search_preprints",
            "chembl_search_activities", "chembl_search_molecules", "chembl_search_targets",
            "chembl_similarity_search",
            "clinvar_get_assertions", "clinvar_lookup_accession", "clinvar_search_variants",
            "datacite_lookup", "datacite_search",
            "ensembl_lookup_gene", "ensembl_lookup_transcript", "ensembl_overlap_region",
            "ensembl_variant_consequence",
            "europe-pmc_prepare_paper_download", "europe-pmc_search",
            "geo_list_files", "geo_lookup_accession", "geo_prepare_dataset_download", "geo_search_studies",
            "gnomad_gene", "gnomad_variant",
            "gtopdb_interactions", "gtopdb_search_ligand", "gtopdb_search_target",
            "gwas_search_gene", "gwas_search_trait",
            "interpro_lookup_entry", "interpro_protein_entries",
            "kegg_find", "kegg_get", "kegg_link",
            "medrxiv_lookup_doi", "medrxiv_prepare_paper_download", "medrxiv_search_preprints",
            "optimade_query_structures",
            "pdb_lookup_structure", "pdb_prepare_structure_download", "pdb_search_structures",
            "pride_files", "pride_project", "pride_search_projects",
            "pubchem_lookup", "pubchem_resolve", "pubchem_search",
            "pubmed_prepare_paper_download", "pubmed_search",
            "reactome_enrichment", "reactome_lookup_pathway", "reactome_search_pathways",
            "string_network", "string_resolve",
            "wikidata_resolve_entity", "wikidata_sparql",
        })

    async def test_database_results_use_manifest_source_identity(self) -> None:
        cases = []
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._pdb_entry",
            new=AsyncMock(return_value={"struct": {"title": "Structure"}}),
        ):
            cases.append(("pdb", await pdb_lookup_structure("1abc")))
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"display_name": "Gene"}),
        ):
            cases.append(("ensembl", await ensembl_lookup_gene("ENSG00000141510")))
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"displayName": "Pathway"}),
        ):
            cases.append(("reactome", await reactome_lookup_pathway("R-HSA-123")))
        with (
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._entrez_search",
                new=AsyncMock(return_value=["1"]),
            ),
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._entrez_summary",
                new=AsyncMock(return_value=[{"accession": "VCV0001", "variation_id": "1"}]),
            ),
        ):
            cases.append(("clinvar", await clinvar_search_variants("VCV0001")))
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"molecules": [{"molecule_chembl_id": "CHEMBL25"}]}),
        ):
            cases.append(("chembl", await chembl_search_molecules("aspirin")))
        with (
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._entrez_search",
                new=AsyncMock(return_value=["2"]),
            ),
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._entrez_summary",
                new=AsyncMock(return_value=[{"accession": "GSE2", "title": "Study"}]),
            ),
        ):
            cases.append(("geo", await geo_search_studies("study")))

        for expected, result in cases:
            self.assertEqual(result["sourceId"], expected)
            self.assertEqual(result["records"][0]["source"], expected)
            self.assertEqual(result["records"][0]["primaryCitation"]["source"], expected)

    async def test_arxiv_fixture_becomes_a_canonical_record(self) -> None:
        atom = """<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>https://arxiv.org/abs/2101.00001v1</id>
            <title>Example preprint</title>
            <summary>Bounded abstract text.</summary>
            <published>2021-01-01T00:00:00Z</published>
            <updated>2021-01-02T00:00:00Z</updated>
            <author><name>A. Author</name></author>
          </entry>
        </feed>"""
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_text",
            new=AsyncMock(return_value=atom),
        ):
            result = await _arxiv_search("example", 5)
        self.assertEqual(result["sourceId"], "arxiv")
        self.assertEqual(result["records"][0]["identifier"], "2101.00001v1")
        self.assertEqual(
            result["records"][0]["primaryCitation"]["markdown"],
            "[Arxiv:2101.00001v1](https://arxiv.org/abs/2101.00001v1)",
        )

    async def test_arxiv_enables_tls_post_handshake_auth_without_changing_other_sources(self) -> None:
        atom = '<feed xmlns="http://www.w3.org/2005/Atom" />'
        client_options = []
        async_client = httpx.AsyncClient

        def make_client(**kwargs):
            client_options.append(kwargs.copy())
            return async_client(
                transport=httpx.MockTransport(lambda request: httpx.Response(200, text=atom)),
                **kwargs,
            )

        with patch("sciencediscovery_gateway.public_biomed_mcp.httpx.AsyncClient", side_effect=make_client):
            await _arxiv_search("trapped ion", 5)
            await _get_text("https://example.org/other-source")

        arxiv_context = client_options[0]["verify"]
        self.assertIsInstance(arxiv_context, ssl.SSLContext)
        self.assertTrue(arxiv_context.post_handshake_auth)
        self.assertTrue(arxiv_context.check_hostname)
        self.assertEqual(arxiv_context.verify_mode, ssl.CERT_REQUIRED)
        self.assertNotIn("verify", client_options[1])

    async def test_arxiv_429_diagnostics_keep_headers_without_logging_query(self) -> None:
        async_client = httpx.AsyncClient

        def make_client(**kwargs):
            return async_client(
                transport=httpx.MockTransport(lambda request: httpx.Response(
                    429, headers={"retry-after": "7", "x-cache": "Error from cloudfront"},
                )),
                **kwargs,
            )

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "arxiv-http.jsonl"
            with (
                patch.dict(os.environ, {"SCIENCE_AGENT_ARXIV_HTTP_LOG": str(path)}),
                patch("sciencediscovery_gateway.public_biomed_mcp.httpx.AsyncClient", side_effect=make_client),
            ):
                with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
                    await _arxiv_search("secret cardiology query", 5)
            raw = path.read_text()
            event = json.loads(raw)
            self.assertEqual(event["status"], 429)
            self.assertEqual(event["retry_after"], "7")
            self.assertEqual(event["x_cache"], "Error from cloudfront")
            self.assertEqual(event["error_type"], "RuntimeError")
            self.assertEqual(len(event["query_sha256"]), 64)
            self.assertNotIn("secret cardiology query", raw)

    async def test_pubmed_empty_search_does_not_make_a_summary_request(self) -> None:
        getter = AsyncMock(return_value={"esearchresult": {"idlist": []}})
        with patch("sciencediscovery_gateway.public_biomed_mcp._get_json", new=getter):
            result = await _pubmed_search("missing", 5)
        self.assertEqual(result["records"], [])
        self.assertEqual(getter.await_count, 1)

    async def test_europe_pmc_fixture_preserves_pmcid(self) -> None:
        payload = {
            "resultList": {
                "result": [{
                    "abstractText": "Abstract",
                    "authorString": "A Author, B Author",
                    "firstPublicationDate": "2020-01-02",
                    "id": "123",
                    "pmcid": "PMC123",
                    "source": "PMC",
                    "title": "Open article",
                }]
            }
        }
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=payload),
        ):
            result = await _europe_pmc_search("open", 5)
        self.assertEqual(result["records"][0]["identifier"], "PMC123")
        self.assertEqual(result["records"][0]["contentScope"], "abstract")

    async def test_pmc_candidate_rejects_non_allowlisted_pdf_host(self) -> None:
        locator = """<OA><records><record license="CC BY">
          <link format="pdf" href="https://attacker.example/paper.pdf"/>
        </record></records></OA>"""
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_text",
            new=AsyncMock(return_value=locator),
        ):
            with self.assertRaisesRegex(ValueError, "host allowlist"):
                await _pmc_pdf_candidate("europe-pmc", "PMC123")

    def test_raise_for_status_keeps_status_and_retry_after_but_not_the_query(self) -> None:
        request = httpx.Request("GET", "https://export.arxiv.org/api/query?search_query=secret")
        response = httpx.Response(429, headers={"retry-after": "5"}, request=request)
        with self.assertRaises(RuntimeError) as caught:
            _raise_for_status(response)
        message = str(caught.exception)
        self.assertIn("429", message)
        self.assertIn("retry-after: 5", message)
        self.assertIn("export.arxiv.org", message)
        self.assertNotIn("secret", message)

    def test_raise_for_status_passes_successful_responses(self) -> None:
        request = httpx.Request("GET", "https://export.arxiv.org/api/query")
        _raise_for_status(httpx.Response(200, request=request))


class Z6BiodataConnectorTests(unittest.IsolatedAsyncioTestCase):
    """Provider-behaviour regressions for the PubChem/AFDB/InterPro/OPTIMADE/
    STRING/BioGRID expansion (ported from the DeepAnalyzet connector pack)."""

    async def test_pubchem_search_and_resolve_preserve_identity_and_encode_values(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"IdentifierList": {"CID": [2244, 2157]}}),
        ) as get_json:
            search = await pubchem_search("aspirin", 5)
        self.assertEqual(search["sourceId"], "pubchem")
        self.assertEqual(search["toolId"], "search")
        self.assertEqual([record["identifier"] for record in search["records"]], ["2244", "2157"])
        self.assertTrue(search["records"][0]["url"].startswith("https://pubchem.ncbi.nlm.nih.gov/compound/"))

        smiles = "CC(=O)Oc1ccccc1C(=O)O"
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"PropertyTable": {"Properties": [
                {"CID": 2244, "IUPACName": "2-acetyloxybenzoic acid", "MolecularFormula": "C9H8O4"},
            ]}}),
        ) as get_json:
            resolve = await pubchem_resolve(smiles, "smiles")
        # SMILES slashes/parentheses must be fully percent-encoded in the path.
        requested_url = get_json.call_args[0][0]
        self.assertIn("compound/smiles/CC%28%3DO%29", requested_url)
        self.assertEqual(resolve["records"][0]["identifier"], "2244")
        self.assertEqual(resolve["records"][0]["title"], "2-acetyloxybenzoic acid")

    async def test_afdb_lookup_derives_fragment_sequence_length_and_warns_about_plddt(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=[{
                "entryId": "AF-P12345-F1", "uniprotAccession": "P12345", "gene": "EXAMPLE",
                "organismScientificName": "Homo sapiens",
                "uniprotStart": 10, "uniprotEnd": 60,  # fragment: no sequenceLength upstream
                "confidenceScore": 88.4, "fractionPlddtVeryHigh": 0.71,
                "cifUrl": "https://alphafold.ebi.ac.uk/files/AF-P12345-F1-model_v4.cif",
                "latestVersion": 4,
            }]),
        ):
            result = await afdb_lookup("p12345")
        record = result["records"][0]
        self.assertEqual(record["source"], "afdb")
        self.assertEqual(record["identifier"], "P12345")
        prediction = record["structuredData"]["predictions"][0]
        self.assertEqual(prediction["sequenceLength"], 51)  # 60 - 10 + 1
        self.assertTrue(any("pLDDT" in warning for warning in record["warnings"]))

    async def test_interpro_lookup_entry_routes_pfam_accessions_to_the_pfam_database(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"metadata": {
                "accession": "PF00069", "name": "Protein kinase domain", "type": "Domain",
                "source_database": "pfam",
                "description": [{"text": "Catalytic <b>domain</b> of protein kinases."}],
            }}),
        ) as get_json:
            result = await interpro_lookup_entry("pf00069")
        requested_url = get_json.call_args[0][0]
        self.assertIn("/entry/pfam/PF00069", requested_url)
        record = result["records"][0]
        self.assertEqual(record["identifier"], "PF00069")
        self.assertIn("/entry/pfam/PF00069", record["url"])
        # Embedded HTML in entry descriptions is stripped before model context.
        self.assertEqual(record["structuredData"]["description"], "Catalytic domain of protein kinases.")

    async def test_optimade_composes_element_filters_and_truncates_ignoring_providers(self) -> None:
        # OQMD was measured to ignore page_limit — return more rows than asked.
        oversize = {"data": [
            {"id": str(index), "attributes": {"chemical_formula_reduced": "LiFePO4", "elements": ["Li", "Fe", "P", "O"], "nsites": 28}}
            for index in range(40)
        ], "meta": {"data_available": 512}}
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=oversize),
        ) as get_json:
            result = await optimade_query_structures(elements="Li,Fe,P,O", provider="oqmd", limit=10)
        params = get_json.call_args[1]["params"]
        self.assertEqual(params["filter"], 'elements HAS ALL "Li","Fe","P","O"')
        self.assertEqual(params["page_limit"], 10)
        self.assertEqual(len(result["records"]), 10)  # truncated locally
        self.assertEqual(result["data"]["provider"], "OQMD")
        self.assertEqual(result["data"]["available"], 512)
        with self.assertRaises(ValueError):
            await optimade_query_structures(provider="csd")

    async def test_optimade_cod_entries_cite_the_entry_page(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"data": [
                {"id": "2018730", "attributes": {"chemical_formula_reduced": "SiO2", "elements": ["Si", "O"]}},
            ], "meta": {}}),
        ):
            result = await optimade_query_structures(formula="SiO2", provider="cod", limit=5)
        record = result["records"][0]
        self.assertEqual(record["identifier"], "cod:2018730")
        self.assertEqual(record["url"], "https://www.crystallography.net/cod/2018730.html")

    async def test_string_network_scales_scores_and_buckets_confidence(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=[
                {"preferredName_A": "TP53", "preferredName_B": "MDM2", "score": 0.999, "ncbiTaxonId": 9606},
                {"preferredName_A": "TP53", "preferredName_B": "BBC3", "score": 0.42, "ncbiTaxonId": 9606},
            ]),
        ):
            result = await string_network("TP53,MDM2", 9606, 10)
        self.assertEqual(result["records"][0]["identifier"], "TP53__MDM2")
        self.assertEqual(result["records"][0]["structuredData"]["combinedScore"], 999)
        self.assertEqual(result["records"][0]["structuredData"]["confidence"], "high")
        self.assertEqual(result["records"][1]["structuredData"]["combinedScore"], 420)
        self.assertEqual(result["records"][1]["structuredData"]["confidence"], "medium")
        self.assertTrue(result["records"][0]["url"].startswith("https://string-db.org/network/9606/"))

    async def test_biogrid_requires_a_key_and_maps_interactions_from_the_dict_payload(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BIOGRID_API_KEY", None)
            with self.assertRaises(RuntimeError) as caught:
                await biogrid_interactions("TP53")
            # The gateway error classifier maps "unauthorized" to UNAUTHORIZED.
            self.assertIn("unauthorized", str(caught.exception))

        payload = {
            "123": {
                "OFFICIAL_SYMBOL_A": "TP53", "OFFICIAL_SYMBOL_B": "MDM2",
                "EXPERIMENTAL_SYSTEM": "two hybrid", "PUBMED_ID": "9150133", "THROUGHPUT": "Low Throughput",
            },
        }
        with (
            patch.dict(os.environ, {"BIOGRID_API_KEY": "test-key"}),
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._get_json",
                new=AsyncMock(return_value=payload),
            ) as get_json,
        ):
            result = await biogrid_interactions("TP53", 9606, 20)
        params = get_json.call_args[1]["params"]
        self.assertEqual(params["accesskey"], "test-key")
        self.assertEqual(params["searchNames"], "true")
        record = result["records"][0]
        self.assertEqual(record["identifier"], "TP53__MDM2")
        self.assertEqual(record["structuredData"]["pubmedId"], "9150133")
        self.assertEqual(record["url"], "https://thebiogrid.org")

    async def test_biogrid_rejects_non_dict_payloads_loudly(self) -> None:
        # A degraded response must not silently read as "no interactions".
        with (
            patch.dict(os.environ, {"BIOGRID_API_KEY": "test-key"}),
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._get_json",
                new=AsyncMock(return_value=[{"OFFICIAL_SYMBOL_A": "TP53"}]),
            ),
        ):
            with self.assertRaises(RuntimeError) as caught:
                await biogrid_interactions("TP53")
        self.assertIn("unexpected payload shape", str(caught.exception))

    async def test_biogrid_skips_degraded_entries_and_reports_them(self) -> None:
        payload = {
            "123": "an upstream error string, not a record",
            "456": {
                "OFFICIAL_SYMBOL_A": "TP53", "OFFICIAL_SYMBOL_B": "MDM2",
                "EXPERIMENTAL_SYSTEM": "two hybrid", "PUBMED_ID": "9150133",
            },
        }
        with (
            patch.dict(os.environ, {"BIOGRID_API_KEY": "test-key"}),
            patch(
                "sciencediscovery_gateway.public_biomed_mcp._get_json",
                new=AsyncMock(return_value=payload),
            ),
        ):
            result = await biogrid_interactions("TP53")
        self.assertEqual(len(result["records"]), 1)
        self.assertTrue(any("1 degraded non-record entries" in w for w in result["warnings"]))

    async def test_gnomad_gene_posts_graphql_and_maps_constraint(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._post_json",
            new=AsyncMock(return_value={"data": {"gene": {
                "gene_id": "ENSG00000141510", "symbol": "TP53",
                "gnomad_constraint": {"oe_lof": 0.06, "oe_mis": 0.51, "oe_lof_upper": 0.11, "oe_mis_upper": 0.69},
            }}}),
        ) as post:
            result = await gnomad_gene("TP53")
        self.assertIn("reference_genome: GRCh38", post.call_args[0][1]["query"])
        record = result["records"][0]
        self.assertEqual(record["identifier"], "ENSG00000141510")
        self.assertEqual(record["structuredData"]["constraint"]["oeLof"], 0.06)
        self.assertTrue(record["url"].startswith("https://gnomad.broadinstitute.org/gene/"))

        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._post_json",
            new=AsyncMock(return_value={"data": {"gene": None}}),
        ):
            with self.assertRaises(RuntimeError):
                await gnomad_gene("NOPE")

    async def test_gnomad_gene_exercises_the_real_post_helper_signature(self) -> None:
        # Regression: a duplicate _post_json definition (json_body= keyword)
        # made every real gnomAD call raise TypeError while AsyncMock seams
        # kept the unit tests green (caught live on 4310, 2026-09-13). This
        # test goes through the REAL helper with only httpx faked, so any
        # future signature drift between caller and helper fails here.
        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload
                self.status_code = 200
            def json(self):
                return self._payload
        class FakeAsyncClient:
            def __init__(self, **_kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_args):
                return False
            async def post(self, _url, json=None, headers=None):
                return FakeResponse({"data": {"gene": {
                    "gene_id": "ENSG00000012048", "symbol": "BRCA1",
                    "gnomad_constraint": {"oe_lof": 0.80, "oe_mis": 0.91, "oe_lof_upper": 0.92, "oe_mis_upper": 0.94},
                }}})
        with patch("sciencediscovery_gateway.public_biomed_mcp.httpx.AsyncClient", new=FakeAsyncClient):
            result = await gnomad_gene("BRCA1")
        self.assertEqual(result["records"][0]["identifier"], "ENSG00000012048")
        self.assertEqual(result["records"][0]["structuredData"]["constraint"]["oeLof"], 0.80)

    async def test_gnomad_variant_validates_the_id_shape(self) -> None:
        with self.assertRaises(ValueError):
            await gnomad_variant("not-a-variant")
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._post_json",
            new=AsyncMock(return_value={"data": {"variant": {
                "variant_id": "1-55516888-G-A", "genome": {"ac": 1, "an": 251_000, "af": 3.98e-6}, "exome": None,
            }}}),
        ):
            result = await gnomad_variant("1-55516888-G-A")
        self.assertEqual(result["records"][0]["structuredData"]["genome"]["af"], 3.98e-6)

    async def test_gwas_maps_v2_association_rows(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"_embedded": {"associations": [{
                "p_value": 5e-8, "risk_frequency": "0.25", "beta": "-",
                "snp_allele": [{"rs_id": "rs121909165", "effect_allele": "A"}],
                "mapped_genes": [{"gene_name": "F5"}],
                "reported_trait": ["Venous thrombosis"],
                "pubmed_id": "31346163", "first_author": "Smith J",
            }]}, "page": {"totalElements": 1}}),
        ) as get_json:
            result = await gwas_search_trait("venous thrombosis", 10)
        self.assertEqual(get_json.call_args[1]["params"]["efo_trait"], "venous thrombosis")
        record = result["records"][0]
        self.assertEqual(record["identifier"], "rs121909165")
        self.assertEqual(record["structuredData"]["gene"], "F5")
        self.assertIsNone(record["structuredData"]["beta"])  # '-' sentinel must become null

    async def test_gwas_empty_label_match_returns_retry_guidance(self) -> None:
        # Live-measured (2026-09-12): efo_trait is exact-label match — a
        # near-miss phrasing yields an empty page that must not look like
        # "no evidence exists".
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"_embedded": {"associations": []}, "page": {"totalElements": 0}}),
        ):
            result = await gwas_search_trait("type 2 diabetes", 5)
        self.assertEqual(result["records"], [])
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("exactly", result["warnings"][0])
        self.assertIn("type 2 diabetes mellitus", result["warnings"][0])

    async def test_gtopdb_decodes_entity_names_and_maps_interactions(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=[{"targetId": 29, "name": "&beta;2-adrenoceptor", "type": "GPCR"}]),
        ):
            result = await gtopdb_search_target("beta2 adrenoceptor")
        self.assertEqual(result["records"][0]["title"], "β2-adrenoceptor")
        self.assertTrue(result["records"][0]["url"].startswith(
            "https://www.guidetopharmacology.org/GRAC/ObjectDisplayForward?objectId=29"))

        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=[{
                "targetName": "β2-adrenoceptor", "targetId": 29, "type": "ligand",
                "action": "agonist", "affinity": "9.3", "affinityUnits": "Log Ka", "endogenous": False,
            }]),
        ):
            interactions = await gtopdb_interactions(7)
        self.assertEqual(interactions["records"][0]["structuredData"]["affinity"], "9.3 Log Ka")

    async def test_kegg_rejects_misused_db_names_and_parses_tsv(self) -> None:
        with self.assertRaises(ValueError) as caught:
            await kegg_find("gene", "p53")
        self.assertIn("use 'genes'", str(caught.exception))
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_text",
            new=AsyncMock(return_value="hsa:10458\tp53; TP53\nhsa:7157\ttumor protein p53\n"),
        ):
            result = await kegg_find("genes", "p53")
        self.assertEqual(result["records"][0]["identifier"], "hsa:10458")
        self.assertTrue(result["records"][0]["url"].startswith("https://www.kegg.jp/entry/hsa:10458"))

        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_text",
            new=AsyncMock(return_value="pathway\thsa04517\npathway\thsa04151\n"),
        ):
            linked = await kegg_link("hsa", "pathway", "10458")
        self.assertEqual(len(linked["records"]), 2)

    async def test_kegg_get_truncates_flat_files(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_text",
            new=AsyncMock(return_value="ENTRY xx\n" + "y" * 5_000),
        ):
            result = await kegg_get("hsa:10458")
        data = result["records"][0]["structuredData"]
        self.assertEqual(data["totalChars"], 5_009)
        self.assertTrue(data["truncated"])

    async def test_pride_project_and_files_handle_dual_payload_shapes(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={
                "accession": "PXD000001", "title": "Human cerebrospinal fluid",
                # search/projects returns plain strings; detail returns CvParams — both must work.
                "organisms": [{"name": "Homo sapiens"}],
                "instruments": ["LTQ Orbitrap"],
                "projectDescription": "Reference proteome.",
                "experimentTypes": [{"name": "Bottom-up proteomics"}],
                "references": [{"referenceLine": "Vizcaíno JA et al.", "doi": "10.1038/nbt.2677", "pubmedID": "23193291"}],
            }),
        ):
            result = await pride_project("pxd000001")
        record = result["records"][0]
        self.assertEqual(record["identifier"], "PXD000001")
        self.assertEqual(record["structuredData"]["species"], ["Homo sapiens"])
        self.assertEqual(record["structuredData"]["instruments"], ["LTQ Orbitrap"])
        self.assertEqual(record["structuredData"]["references"][0]["pubmedId"], "23193291")

        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=[{
                "fileName": "fragment.mgf", "fileCategory": {"value": "Peak list file"},
                "fileSizeBytes": 123, "checksum": "abc",
                "publicFileLocations": [{"name": "ftp protocol", "value": "ftp://ftp.pride.ebi.ac.uk/fragment.mgf"}],
            }]),
        ):
            files = await pride_files("PXD000001")
        self.assertEqual(files["records"][0]["structuredData"]["category"], "Peak list file")
        # Download URLs stay inside structuredData (out-of-allowlist hosts),
        # never in the record landing URL.
        self.assertTrue(files["records"][0]["url"].startswith("https://www.ebi.ac.uk/pride/archive/projects/"))

    async def test_wikidata_enforces_select_only_and_maps_bindings(self) -> None:
        with self.assertRaises(ValueError):
            await wikidata_sparql("DELETE WHERE { ?s ?p ?o }")
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"results": {"bindings": [{
                "item": {"value": "http://www.wikidata.org/entity/Q148", "type": "uri"},
                "itemLabel": {"value": "China", "type": "literal"},
            }]}}),
        ) as get_json:
            result = await wikidata_sparql("SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q6256. }")
        self.assertIn("LIMIT 20", get_json.call_args[1]["params"]["query"])
        record = result["records"][0]
        self.assertEqual(record["identifier"], "Q148")
        self.assertTrue(record["url"].startswith("https://www.wikidata.org/wiki/Q148"))

    async def test_wikidata_resolve_entity_builds_a_label_query(self) -> None:
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"results": {"bindings": [{
                "item": {"value": "http://www.wikidata.org/entity/Q22786", "type": "uri"},
                "itemLabel": {"value": "aspirin", "type": "literal"},
                "itemDescription": {"value": "medication", "type": "literal"},
            }]}}),
        ) as get_json:
            result = await wikidata_resolve_entity('the "aspirin"', "en")
        # Embedded quotes in the label must be escaped, not break the query.
        self.assertIn('\\"aspirin\\"', get_json.call_args[1]["params"]["query"])
        self.assertEqual(result["records"][0]["identifier"], "Q22786")

    async def test_datacite_search_and_lookup_map_doi_records(self) -> None:
        doi_payload = {"data": {
            "id": "10.5281/zenodo.12345",
            "attributes": {
                "titles": [{"title": "Proteomics dataset"}],
                "publisher": "Zenodo",
                "publicationYear": 2024,
                "types": {"resourceTypeGeneral": "Dataset"},
                "creators": [{"name": "Doe J"}],
                "url": "https://zenodo.org/record/12345",
                "descriptions": [{"description": "A dataset."}],
            },
        }}
        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value=doi_payload),
        ) as get_json:
            result = await datacite_lookup("https://doi.org/10.5281/zenodo.12345")
        self.assertEqual(get_json.call_args[0][0], "https://api.datacite.org/dois/10.5281/zenodo.12345")
        record = result["records"][0]
        self.assertEqual(record["url"], "https://doi.org/10.5281/zenodo.12345")
        self.assertEqual(record["structuredData"]["repository"], "Zenodo")

        with patch(
            "sciencediscovery_gateway.public_biomed_mcp._get_json",
            new=AsyncMock(return_value={"data": [doi_payload["data"]], "meta": {"total": 1}}),
        ) as get_json:
            found = await datacite_search("proteomics", 2024, 10)
        self.assertEqual(get_json.call_args[1]["params"]["resource-type-general"], "dataset")
        self.assertEqual(get_json.call_args[1]["params"]["publicationYear"], 2024)
        self.assertEqual(len(found["records"]), 1)


if __name__ == "__main__":
    unittest.main()
