"""Versioned, frozen research templates for the autonomous Idea Tree."""
from __future__ import annotations

from copy import deepcopy

from . import prompts


GENERAL = {
    'id': 'scientific-hypothesis-general/v1',
    'label': '通用科研假设探索',
    'design': """You are a scientific hypothesis designer. Turn the assigned hypothesis into a falsifiable research design. State the proposed mechanism, key variables, alternative explanations, measurements or observations that would support or refute it, controls, feasibility limits and the next validation step. Separate supplied evidence from assumptions. Do not invent results or citations.""",
    'aggregate': """Synthesize the independent assessments into reusable research learning. Separate strengths, failure modes, uncertainty, evidence gaps, next validation moves and hard constraints. The numeric score is calculated by Python; do not replace it. Do not invent evidence.""",
    'propagate': """Update the research direction with reusable lessons from its assessed children. Preserve negative findings, uncertainty, evidence gaps and useful next questions. Omitted branches are not failures. Clearly distinguish evidence from hypotheses.""",
    'assessors': [
        {'id': 'scientificValidity', 'label': '科学合理性', 'weight': .40, 'criteria': 'Assess mechanism plausibility, falsifiability, alternative explanations, confounders and whether the hypothesis follows from the stated evidence.'},
        {'id': 'evidenceReadiness', 'label': '证据与验证准备度', 'weight': .35, 'criteria': 'Assess evidence quality, missing controls, measurable predictions, validation path and uncertainty. Estimated performance is not measured performance.'},
        {'id': 'feasibility', 'label': '可行性与风险', 'weight': .25, 'criteria': 'Assess practical feasibility, resources, safety or ethics constraints, reproducibility and the most important implementation risks.'},
    ],
}

WATER_TREATMENT = {
    'id': 'water-treatment-materials/v1',
    'label': '水处理材料设计',
    'design': prompts.DESIGN,
    'aggregate': prompts.AGGREGATE,
    'propagate': prompts.PROPAGATE,
    'assessors': [
        {'id': role, 'label': role, 'weight': weight, 'criteria': prompts.CRITERIA[role]}
        for role, weight in zip(('activity', 'stability', 'sustainability'), (.35, .35, .30))
    ],
}

TEMPLATES = {template['id']: template for template in (GENERAL, WATER_TREATMENT)}

INTENSITIES = {
    'quick': {'maxRounds': 2, 'candidatesPerRound': 2, 'maxSearchRounds': 4, 'maxActiveDirections': 2, 'explorationSlots': 1, 'candidateConcurrency': 2},
    'standard': {'maxRounds': 3, 'candidatesPerRound': 3, 'maxSearchRounds': 10, 'maxActiveDirections': 3, 'explorationSlots': 1, 'candidateConcurrency': 3},
    'deep': {'maxRounds': 6, 'candidatesPerRound': 4, 'maxSearchRounds': 24, 'maxActiveDirections': 5, 'explorationSlots': 2, 'candidateConcurrency': 4},
}


def snapshot(template_id: str) -> dict:
    if template_id not in TEMPLATES:
        raise ValueError('Unknown research template')
    return deepcopy(TEMPLATES[template_id])


def apply_intensity(settings: dict, intensity: str) -> dict:
    if intensity not in INTENSITIES:
        raise ValueError('Unknown exploration intensity')
    return {**settings, **INTENSITIES[intensity], 'explorationIntensity': intensity}
