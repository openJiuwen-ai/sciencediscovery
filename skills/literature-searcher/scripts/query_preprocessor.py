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

"""Query preprocessing helpers for literature-searcher scripts.

The functions in this module are intentionally dependency-free and conservative:
they shorten long natural-language topics, expand common scientific acronyms,
generate a few database query variants, and provide lightweight relevance
filtering for noisy APIs.
"""

from __future__ import annotations

import re
from typing import Iterable


STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "based", "by", "for", "from",
    "how", "in", "into", "is", "of", "on", "or", "study", "the", "to",
    "using", "via", "with",
}

ACRONYM_EXPANSIONS = {
    "gnn": "graph neural network",
    "gnns": "graph neural networks",
    "mpnn": "message passing neural network",
    "mpnns": "message passing neural networks",
    "ml": "machine learning",
    "dl": "deep learning",
    "nlp": "natural language processing",
}

DOMAIN_DEFAULTS = {
    "BIOMEDICINE": {
        "arxiv_category": "q-bio.*",
        "pubmed_mesh": "Neural Networks, Computer",
        "crossref_filter": "type:journal-article",
    },
    "CHEMISTRY": {
        "arxiv_category": "physics.chem-ph",
        "pubmed_mesh": None,
        "crossref_filter": "type:journal-article",
    },
    "MATERIALS": {
        "arxiv_category": "cond-mat.mtrl-sci",
        "pubmed_mesh": None,
        "crossref_filter": "type:journal-article",
    },
    "FINANCE": {
        "arxiv_category": "q-fin.*",
        "pubmed_mesh": None,
        "crossref_filter": "type:journal-article",
    },
    "COMPUTER_SCIENCE": {
        "arxiv_category": "cs.LG",
        "pubmed_mesh": "Neural Networks, Computer",
        "crossref_filter": "type:journal-article",
    },
    "GENERAL": {
        "arxiv_category": None,
        "pubmed_mesh": None,
        "crossref_filter": "type:journal-article",
    },
}


def normalize_domain(domain: str | None) -> str:
    if not domain:
        return "GENERAL"
    domain = domain.strip().upper().replace("-", "_").replace(" ", "_")
    return domain if domain in DOMAIN_DEFAULTS else "GENERAL"


def domain_defaults(domain: str | None) -> dict:
    return DOMAIN_DEFAULTS[normalize_domain(domain)]


def normalize_text(text: str) -> str:
    text = re.sub(r"[_/]+", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def expand_acronyms(text: str) -> str:
    """Expand known acronyms without duplicating already-expanded phrases."""
    text = normalize_text(text)
    lowered = text.lower()
    additions = []
    for acronym, expansion in ACRONYM_EXPANSIONS.items():
        if re.search(rf"\b{re.escape(acronym)}\b", lowered) and expansion not in lowered:
            additions.append(expansion)
    if additions:
        text = f"{text} {' '.join(additions)}"
    return normalize_text(text)


def tokenize(text: str) -> list[str]:
    text = expand_acronyms(text).lower()
    raw_tokens = re.findall(r"[a-z][a-z0-9-]*", text)
    return [t for t in raw_tokens if t not in STOPWORDS and len(t) > 1]


def _has_all(tokens: Iterable[str], *required: str) -> bool:
    token_set = set(tokens)
    return all(t in token_set for t in required)


def key_phrases(topic: str) -> list[str]:
    tokens = tokenize(topic)
    token_set = set(tokens)
    phrases: list[str] = []

    if "graph" in token_set and "neural" in token_set and ("network" in token_set or "networks" in token_set):
        phrases.append("graph neural network")
    if "message" in token_set and "passing" in token_set:
        phrases.append("message passing neural network")
    if "transformer" in token_set and "attention" in token_set:
        phrases.append("transformer attention")
    if "diffusion" in token_set and ("model" in token_set or "models" in token_set):
        phrases.append("diffusion models")
    if "molecular" in token_set and "property" in token_set:
        phrases.append("molecular property prediction" if "prediction" in token_set else "molecular property")
    elif "molecular" in token_set:
        phrases.append("molecular")
    if "protein" in token_set and ("structure" in token_set or "folding" in token_set):
        phrases.append("protein structure")

    for token in tokens:
        if token not in {"network", "networks", "models", "model", "prediction"} and token not in " ".join(phrases):
            phrases.append(token)
        if len(phrases) >= 5:
            break

    return phrases[:5] or tokens[:3]


def core_query(topic: str, max_terms: int = 4) -> str:
    phrases = key_phrases(topic)
    if not phrases:
        return normalize_text(topic)

    if "graph neural network" in phrases and any(p.startswith("molecular") for p in phrases):
        return "graph neural network molecular"
    if "message passing neural network" in phrases and any(p.startswith("molecular") for p in phrases):
        return "message passing neural network molecular"

    selected = []
    for phrase in phrases:
        selected.extend(phrase.split())
        if len(selected) >= max_terms:
            break
    return " ".join(selected[:max_terms])


def query_variants(topic: str, limit: int = 4) -> list[str]:
    phrases = key_phrases(topic)
    variants: list[str] = []

    if "graph neural network" in phrases and any(p.startswith("molecular") for p in phrases):
        variants.extend([
            "graph neural network molecular",
            "graph neural network molecular property",
            "message passing neural network molecular",
            "molecular property prediction",
        ])
    elif "transformer attention" in phrases:
        variants.extend(["transformer attention", "attention mechanism transformer", "self attention transformer"])
    elif "diffusion models" in phrases:
        variants.extend(["diffusion models", "score based generative models", "denoising diffusion"])
    else:
        variants.append(core_query(topic))
        if len(phrases) > 1:
            variants.append(" ".join(phrases[:2]))
        if len(phrases) > 2:
            variants.append(" ".join(phrases[1:4]))

    seen = set()
    unique = []
    for variant in variants:
        variant = normalize_text(variant)
        if variant and variant.lower() not in seen:
            unique.append(variant)
            seen.add(variant.lower())
        if len(unique) >= limit:
            break
    return unique or [normalize_text(topic)]


def relevance_groups(topic: str) -> list[list[str]]:
    tokens = set(tokenize(topic))
    groups: list[list[str]] = []
    if {"graph", "neural"} <= tokens or "gnn" in tokens:
        groups.append(["graph neural", "graph neural network", "gnn", "message passing neural", "mpnn"])
    elif "neural" in tokens and ("network" in tokens or "networks" in tokens):
        groups.append(["neural network", "neural networks"])

    if "molecular" in tokens or "molecule" in tokens or "molecules" in tokens:
        groups.append(["molecular", "molecule", "molecules", "chemical"])

    if "property" in tokens or "properties" in tokens:
        groups.append(["property", "properties"])
    if "prediction" in tokens or "predict" in tokens or "predicting" in tokens:
        groups.append(["prediction", "predict", "predicting", "predicted"])

    if not groups:
        keyword_terms = [t for t in tokenize(topic) if len(t) > 3][:3]
        groups = [[term] for term in keyword_terms]
    return groups


def text_matches_groups(text: str, groups: list[list[str]]) -> bool:
    haystack = normalize_text(text).lower()
    if not groups:
        return True
    return all(any(term in haystack for term in group) for group in groups)


def relevance_score(source: dict, topic: str) -> int:
    text = " ".join([
        str(source.get("title", "")),
        str(source.get("abstract", "")),
        str(source.get("venue", "")),
    ]).lower()
    groups = relevance_groups(topic)
    matched = sum(1 for group in groups if any(term in text for term in group))
    if not groups:
        return 0
    return round(10 * matched / len(groups))


def filter_relevant_sources(
    sources: list[dict],
    topic: str,
    min_score: int = 6,
    require_all_groups: bool = False,
) -> list[dict]:
    filtered = []
    groups = relevance_groups(topic)
    for source in sources:
        score = relevance_score(source, topic)
        text = " ".join([
            str(source.get("title", "")),
            str(source.get("abstract", "")),
            str(source.get("venue", "")),
        ])
        if require_all_groups and not text_matches_groups(text, groups):
            continue
        if score >= min_score:
            item = dict(source)
            item["relevance_score"] = score
            if score >= 9:
                item["relevance_label"] = "HIGH"
            elif score >= 6:
                item["relevance_label"] = "MEDIUM"
            else:
                item["relevance_label"] = "LOW"
            filtered.append(item)
    return filtered
