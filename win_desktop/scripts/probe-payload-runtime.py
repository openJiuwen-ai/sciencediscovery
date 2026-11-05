"""Runtime probe for the ASSEMBLED payload: prove the swept venv still works.

This is the in-repo, re-runnable replacement for the offline size audit that the
sweep rules in scripts/lib/payload-slim.mjs used to cite (a directory on one
Windows machine that nobody else could open). It exercises the paths a static
import scan cannot see. There are two distinct kinds, and a rule can be wrong in
either:

  * LAZY import — the package is a genuine dead end at module scope, so the scan
    reports nothing no matter how carefully it walks.
      - onnxruntime: chromadb imports it INSIDE its default embedding function
        (chromadb/utils/embedding_functions/onnx_mini_lm_l6_v2.py:70), so
        `import chromadb` stays green whether or not it is installed.
      - kubernetes: imported by chromadb's distributed segment client only
        (segment/impl/distributed/segment_directory.py:4); the product builds the
        embedded PersistentClient, so that module is never loaded.
  * TRANSITIVE chain — the scan walked jiuwenswarm + openjiuwen and stopped
    there, so it never saw what THEIR dependencies import.
      - babel: reached only as openjiuwen -> trafilatura (lazy) -> courlan ->
        babel (module scope). A rule justified by "jinja2 hard dep" swept it
        while jinja2 was not even installed. See assertion 4 below.

A source-level import scan of jiuwenswarm + openjiuwen proves only that THEIR
code does not import those modules at module scope. It says nothing about what
chromadb does at runtime, and nothing at all about the third-party graph below
it. Both gaps are what review called out (agent-ci-infra-bot F2 / yuanzhou75
"P2 — a static import scan cannot justify removing a lazily imported package");
the babel regression is what a scan of only the first party missed anyway.

What is asserted, and why each assertion is the one that matters:

1. The store the product actually builds — openjiuwen's external-memory provider
   calls core.foundation.store.create_vector_store (openjiuwen_memory_provider.py
   :287-288), NOT the core.retrieval store. Writing and querying one item
   through it proves the embedded chroma path works after the sweep.
2. Ranking must be correct, not merely non-empty. Two parallel vectors score
   identically under cosine, so an early version of this probe asserted nothing:
   the vectors here are orthogonal and the query leans towards one of them.
3. Reaching chromadb's DEFAULT embedding function must fail readably. The product
   never gets there (ChromaVectorStore.search passes query_embeddings only;
   jiuwenswarm never imports a Retriever, so sparse_search — the only
   query_texts caller — is unreachable). But if a user-configured collection ever
   did reach it, the sweep must produce a ValueError with an actionable message,
   which is what chromadb's own guard raises, and NOT a bare ModuleNotFoundError.
   If this ever flips to ModuleNotFoundError, onnxruntime has to go back in.
4. The HTML compressor must still extract with trafilatura, NOT silently degrade
   to its beautifulsoup fallback. This is the check the first three would never
   have caught, and the reason it is here: babel was swept under a rule that
   claimed "jinja2 hard dep", but jinja2 is not even installed — the real chain
   is openjiuwen html_compressor.py:55 (lazy `import_module("trafilatura")`,
   unguarded) -> trafilatura/__init__.py:17 -> downloads.py:22 -> courlan ->
   courlan/filters.py:11 (`from babel import Locale`, module scope). A scan of
   jiuwenswarm + openjiuwen cannot see a dependency three hops away, and a
   chromadb-only probe cannot either. compress() swallows the ModuleNotFoundError
   and returns a worse extraction with no error and no log, so the only way to
   catch it is to RUN the compressor and read which extractor it picked. Rule
   compression is on by default (message_offloader.py:29 hardcodes
   "rule_then_truncate"), so this is a live path, not a corner.
5. The sweep must have actually SWEPT. Assertions 1-4 all prove that what was
   KEPT still works; none of them can notice that a rule stopped matching, so a
   rule that silently no-ops ships its dead weight back and every check stays
   green. The package table is therefore asserted, not merely printed:
   onnxruntime and kubernetes must be ABSENT, and babel/courlan/trafilatura/
   chromadb/openjiuwen must be PRESENT. This is the second, independent catch
   for the babel regression in assertion 4 — that one reports the symptom (a
   degraded extractor), this one names the cause (babel missing) — and it is the
   only catch for a rule that fails in the opposite direction.
   Dev trees legitimately keep the swept packages, so SD_PROBE_DEV_TREE=1 drops
   the ABSENT half and keeps the PRESENT half (review finding F12). The value is
   compared to exactly "1" on purpose: a mistyped "true"/"yes" keeps BOTH halves
   enforced, so a typo fails loudly on a dev tree instead of silently disabling
   a check on a payload. assemble-backend.mjs also DELETES the variable from the
   probe environment, because it spreads process.env and a dev machine that
   exports the switch would otherwise weaken a real payload build.

What this probe deliberately does NOT cover: the node_modules sweeps in
assemble-backend.mjs (@openai/codex vendored toolchains, sweepNodeModules). This
interpreter cannot see them, and a Python probe that claimed to would be a check
in name only. Those have their own post-sweep verification — see
leftoverCodexVendorDirs in scripts/lib/payload-slim.mjs.

Exit code 0 with the final PROBE_OK line means all of the above held.

Usage:
    <payload>/.venv/Scripts/python.exe scripts/probe-payload-runtime.py
assemble-backend.mjs runs it as the A1 gate's third check (label
"jw runtime paths"), so a sweep rule that removes too much fails the build.
"""

import asyncio
import importlib.util
import os
import sys
import tempfile


DIM = 8

# Assertion 5's two halves, split because they can legitimately disagree between
# a payload and a dev tree. NEVER_PRESENT is what the sweep rules in
# scripts/lib/payload-slim.mjs delete; ALWAYS_PRESENT is what those same rules
# must never touch, i.e. the babel chain plus everything the probe needs to run
# at all. Kept as module constants so the failure message below can name the
# half a package belongs to instead of just saying "unexpected".
NEVER_PRESENT = ("onnxruntime", "kubernetes")
ALWAYS_PRESENT = ("babel", "courlan", "trafilatura", "chromadb", "openjiuwen")

# Orthogonal on purpose. Cosine ignores magnitude, so [0.1]*8 and [0.9]*8 point
# the same way and both score 1.0 — the assertion behind them would be vacuous.
VEC_A = [1.0] + [0.0] * (DIM - 1)
VEC_B = [0.0, 1.0] + [0.0] * (DIM - 2)
QUERY = [0.9, 0.1] + [0.0] * (DIM - 2)


async def probe_store():
    """Write and query one item through the store the product really uses."""
    from openjiuwen.core.foundation.store import (
        CollectionSchema,
        FieldSchema,
        create_vector_store,
    )
    from openjiuwen.core.foundation.store.base_vector_store import VectorDataType

    tmp = tempfile.mkdtemp(prefix="sd-payload-probe-")
    store = create_vector_store("chroma", persist_directory=tmp)
    kind = type(store).__name__
    if kind != "ChromaVectorStore":
        raise AssertionError(f"expected ChromaVectorStore, got {kind}")

    schema = CollectionSchema(fields=[
        FieldSchema(name="id", dtype=VectorDataType.VARCHAR, is_primary=True),
        FieldSchema(name="text", dtype=VectorDataType.VARCHAR),
        FieldSchema(name="embedding", dtype=VectorDataType.FLOAT_VECTOR, dim=DIM),
    ])
    await store.create_collection("probe_items", schema, distance_metric="cosine")
    await store.add_docs("probe_items", [
        {"id": "a", "text": "payload probe item a", "embedding": VEC_A},
        {"id": "b", "text": "payload probe item b", "embedding": VEC_B},
    ])

    hits = await store.search(
        "probe_items", query_vector=QUERY, vector_field="embedding", top_k=2
    )
    ordered = [h.fields.get("id") for h in hits]
    if ordered[:1] != ["a"]:
        raise AssertionError(f"nearest neighbour wrong: {ordered}")
    if len(hits) < 2:
        raise AssertionError(f"expected 2 hits, got {len(hits)}")
    return kind, ordered, [round(h.score, 4) for h in hits]


def probe_default_embedding():
    """chromadb's default EF must fail READABLY, not with ModuleNotFoundError.

    Both checks go through a collection that carries NO hand-made vectors: the
    upsert passes documents only, so chromadb embeds them with its own default EF
    and the later query_texts uses that same EF. Dimensions therefore always
    agree. An earlier version seeded the collection with the 8-dim VEC_A and then
    queried by text, which raised InvalidArgumentError ("expecting embedding with
    dimension of 8, got 384") whenever onnxruntime WAS installed — the probe
    failed on a healthy venv, and only passed on the swept one, so the bug was
    invisible in the single environment it had been run in. A dimension mismatch
    here says nothing about the sweep.
    """
    import chromadb
    from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import (
        ONNXMiniLM_L6_V2,
    )

    tmp = tempfile.mkdtemp(prefix="sd-payload-probe-ef-")
    col = chromadb.PersistentClient(path=tmp).get_or_create_collection("probe_ef")

    # (1) through the collection's own add path, i.e. what a documents-only
    # upsert hits — the first call that needs the default EF.
    via_add = _classify(
        lambda: col.upsert(ids=["a"], documents=["payload probe item a"])
    )
    # (2) through the embedding function directly.
    via_ef = _classify(lambda: ONNXMiniLM_L6_V2()(["probe"]))
    # (3) through the query path, the one a query_texts caller reaches. Only
    # meaningful if the add above succeeded, else the collection has nothing in
    # it and the error would describe an empty collection instead of the EF.
    via_query = (
        _classify(lambda: col.query(query_texts=["probe"], n_results=1))
        if via_add[0] == "works"
        else via_add
    )
    return via_add, via_query, via_ef


def _classify(fn):
    """Return (verdict, message) for a call that may raise."""
    try:
        fn()
        return "works", ""
    except ModuleNotFoundError as exc:
        # The bad case: an unguarded import of a swept package.
        return "modulenotfound", str(exc)[:200]
    except Exception as exc:  # noqa: BLE001 - the type IS the assertion
        return type(exc).__name__, str(exc)[:200]


# Article-shaped, NOT report-shaped, so HtmlCompressor.compress() takes the
# trafilatura branch instead of jumping straight to the beautifulsoup fallback
# (_looks_like_report_html must be false, or the probe would pass by never
# touching the code under test). Metadata tags are included because their
# extraction is the second half of the assertion: the fallback path returns them
# as None, so they distinguish "degraded" from "worked" even if the text output
# were similar.
_HTML_FIXTURE = """<html><head><title>Payload Probe Document</title>
<meta name="author" content="A. Writer">
<meta name="date" content="2026-11-02"></head>
<body><article>
<h1>Payload Probe Document</h1>
<p>First paragraph of the fixture, long enough that the extractor keeps it and
the savings ratio clears the minimum threshold set on the rule context.</p>
<p>Second paragraph, also carrying enough text to survive extraction, so the
compressor reports a real reduction rather than returning the input unchanged.</p>
<ul><li>a list item with enough words to be retained by the extractor</li>
<li>another list item, likewise long enough to be kept in the output</li></ul>
<p>Closing paragraph so the document has a tail as well as a head.</p>
</article></body></html>"""


def probe_html_compressor():
    """Run the product's own HTML compressor and report which extractor won.

    Returns (extractor, title) as observed. The caller asserts, so a failure here
    names the actual degradation instead of a generic exception.
    """
    from openjiuwen.core.context_engine.processor.forked.offloader.rule_compression.compressors.html_compressor import (  # noqa: E502
        HtmlCompressor,
    )
    from openjiuwen.core.context_engine.processor.forked.offloader.rule_compression.types import (  # noqa: E502
        RuleContext,
    )

    result = HtmlCompressor().compress(_HTML_FIXTURE, RuleContext(max_tokens=4000))
    details = result.details or {}
    return details.get("extractor"), details.get("title")


def check_packages(present):
    """Assertion 5: the sweep must have actually swept.

    Returns an error string, or None. Assertions 1-4 all exercise what the sweep
    KEPT, so a rule that stopped matching — a renamed dist-info, a path the
    flattener no longer produces, a typo in the match string — leaves every one
    of them green while the dead weight ships again. The babel regression is the
    mirror image and shows why both halves matter: a rule that removes too much
    degrades assertion 4, but only the PRESENT half of this table NAMES babel as
    the missing package instead of reporting the downstream symptom.

    A dev tree legitimately keeps onnxruntime and kubernetes (setup syncs the
    full dependency set), so SD_PROBE_DEV_TREE=1 skips the NEVER_PRESENT half.
    The PRESENT half is NOT skippable: nothing that must stay is ever optional.
    """
    dev_tree = os.environ.get("SD_PROBE_DEV_TREE", "") == "1"
    wrong_present = [name for name in NEVER_PRESENT if present.get(name)]
    missing = [name for name in ALWAYS_PRESENT if not present.get(name)]
    if dev_tree:
        wrong_present = []
    if not wrong_present and not missing:
        return None

    parts = []
    if missing:
        parts.append(
            "MISSING (a rule removed something it must never touch): "
            + ", ".join(missing)
        )
    if wrong_present:
        parts.append(
            "STILL PRESENT (a sweep rule no longer matches, so its dead weight "
            "ships): " + ", ".join(wrong_present)
        )
    # Advice is tied to what actually went wrong. Both halves used to get the
    # babel paragraph, so a tree that merely KEPT onnxruntime was told "babel
    # must stay" while babel was present — noise that hides the real line.
    advice = []
    if "babel" in missing:
        advice.append(
            "babel must stay: openjiuwen's HTML compressor imports trafilatura "
            "lazily and unguarded, trafilatura requires courlan, and courlan "
            "imports babel at module scope (courlan/filters.py:11). With babel "
            "missing, compress() swallows the ModuleNotFoundError and silently "
            "falls back to beautifulsoup — no error, no log, just a worse "
            "extraction."
        )
    if wrong_present:
        advice.append(
            "The STILL PRESENT names are the ones a rule in payload-slim.mjs "
            "claims to delete; if the package is genuinely needed at runtime, "
            "the RULE is wrong (that is how babel shipped a regression), so "
            "remove the rule and add the name to NEVER_PRESENT/ALWAYS_PRESENT "
            "here to match."
        )
    return (
        "package table does not match the sweep rules in "
        "scripts/lib/payload-slim.mjs — " + "; ".join(parts) + ". "
        f"Observed: {present}. "
        + (
            "This tree declares SD_PROBE_DEV_TREE=1, so the ABSENT half "
            "(onnxruntime/kubernetes) was not enforced; the PRESENT half is "
            "never optional. "
            if dev_tree else ""
        )
        + (" ".join(advice) if advice else "")
    )


def main():
    present = {
        name: importlib.util.find_spec(name) is not None
        for name in NEVER_PRESENT + ALWAYS_PRESENT
    }
    print("packages present:", present)

    # Assertion 5 runs FIRST, and its PRESENT half is the reason: chromadb and
    # openjiuwen are what every probe below imports, so if one is missing the
    # later failures would be an ImportError about a package the probe needs,
    # not a statement about the sweep. Naming it here keeps the diagnosis
    # pointed at the rule that broke.
    table_error = check_packages(present)
    if table_error:
        print(f"FAIL: {table_error}", file=sys.stderr)
        return 1

    kind, ordered, scores = asyncio.run(probe_store())
    print(f"store write+query: {kind} -> {ordered} scores={scores}")

    via_add, via_query, via_ef = probe_default_embedding()
    print("chromadb default EF via documents upsert:", via_add)
    print("chromadb default EF via query_texts     :", via_query)
    print("chromadb default EF via constructor     :", via_ef)

    # The sweep's promise: a missing onnxruntime surfaces as chromadb's own
    # ValueError ("The onnxruntime python package is not installed. Please
    # install it with `pip install onnxruntime`"), which tells the user what to
    # do. A bare ModuleNotFoundError would mean the guard did not fire and the
    # sweep has to keep onnxruntime instead.
    #
    # "works" is now conditional, and assertion 5 is what makes it so: on a
    # payload tree onnxruntime is guaranteed ABSENT above, so a working EF is
    # impossible and means assertion 5 was bypassed (SD_PROBE_DEV_TREE set
    # against a payload, or NEVER_PRESENT edited). On a dev tree it is expected.
    # This used to accept "works" unconditionally, which is how F12 could point
    # at `'onnxruntime': True` being printed and passed — the same value now
    # fails earlier, with the rule named.
    dev_tree = os.environ.get("SD_PROBE_DEV_TREE", "") == "1"
    for label, (verdict, message) in (
        ("documents upsert", via_add),
        ("query_texts", via_query),
        ("constructor", via_ef),
    ):
        if verdict == "ValueError":
            continue
        if verdict == "works":
            if dev_tree:
                continue
            print(
                f"FAIL: chromadb's default EF WORKED via {label}, which needs "
                "onnxruntime installed — but assertion 5 above requires it "
                "absent on a payload tree. Either SD_PROBE_DEV_TREE=1 was set "
                f"against a real payload (observed table: {present}), or "
                "NEVER_PRESENT no longer lists onnxruntime.",
                file=sys.stderr,
            )
            return 1
        if verdict == "modulenotfound":
            print(f"FAIL: default EF reached a bare ModuleNotFoundError via {label}: {message}",
                  file=sys.stderr)
            return 1
        print(f"FAIL: default EF via {label} raised an unexpected {verdict}: {message}",
              file=sys.stderr)
        return 1

    extractor, title = probe_html_compressor()
    print(f"html compressor extractor: {extractor} title={title!r}")
    # Assert the EXTRACTOR, not the absence of an exception. compress() catches
    # ModuleNotFoundError and returns a perfectly valid-looking result through the
    # beautifulsoup fallback, so the babel regression produced no error, no log
    # and exit 0 — it just extracted less. Only "which path ran" reveals it.
    if extractor != "trafilatura":
        print(
            f"FAIL: HTML compressor degraded to extractor={extractor!r}. "
            "HtmlCompressor.compress() catches ModuleNotFoundError and silently "
            "falls back to beautifulsoup, so this is a functional regression with "
            "no error and no log. The usual cause is a sweep removing a TRANSITIVE "
            "dependency of trafilatura: openjiuwen requires trafilatura "
            "(METADATA:38), which requires courlan (METADATA:42), which requires "
            "babel>=2.16.0 and imports it at module scope (courlan/filters.py:11). "
            "Run `-c \"import trafilatura\"` in the payload venv to name the "
            "missing module. Do NOT fix this by deleting babel/locale-data: "
            "Locale.parse then raises FileNotFoundError for every valid locale, "
            "which courlan's `except (TypeError, UnknownLocaleError)` does not "
            "catch, turning a silent degradation into a crash.",
            file=sys.stderr,
        )
        return 1
    if title != "Payload Probe Document":
        print(f"FAIL: HTML compressor ran trafilatura but extracted title={title!r}",
              file=sys.stderr)
        return 1

    print("PROBE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
