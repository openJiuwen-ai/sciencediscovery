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

import json
import os
import socket
import socketserver
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch

import httpx

from sciencediscovery_gateway.public_biomed_mcp import (
    SERVER,
    _arxiv_search,
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
    ensembl_lookup_gene,
    geo_search_studies,
    interpro_lookup_entry,
    optimade_query_structures,
    pdb_lookup_structure,
    pubchem_resolve,
    pubchem_search,
    reactome_lookup_pathway,
    string_network,
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
            "ensembl_lookup_gene", "ensembl_lookup_transcript", "ensembl_overlap_region",
            "ensembl_variant_consequence",
            "europe-pmc_prepare_paper_download", "europe-pmc_search",
            "geo_list_files", "geo_lookup_accession", "geo_prepare_dataset_download", "geo_search_studies",
            "interpro_lookup_entry", "interpro_protein_entries",
            "medrxiv_lookup_doi", "medrxiv_prepare_paper_download", "medrxiv_search_preprints",
            "optimade_query_structures",
            "pdb_lookup_structure", "pdb_prepare_structure_download", "pdb_search_structures",
            "pubchem_lookup", "pubchem_resolve", "pubchem_search",
            "pubmed_prepare_paper_download", "pubmed_search",
            "reactome_enrichment", "reactome_lookup_pathway", "reactome_search_pathways",
            "string_network", "string_resolve",
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


if __name__ == "__main__":
    unittest.main()
