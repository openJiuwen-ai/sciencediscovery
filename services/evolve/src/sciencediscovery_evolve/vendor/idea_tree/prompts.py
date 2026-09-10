"""Role instructions for the autonomous research engine; no agent tools required."""
IDEATE = """Propose executable research hypotheses from the supplied objective, constraints,
materials and prior findings. Early exploration must cover distinct mechanisms or structures.
Later hypotheses must address a specific prior weakness or unresolved alternative, naming the
source candidate, change, evaluation question and tradeoff. Never invent literature evidence.
Return candidates using existing parent IDs, or a new direction name. An empty candidates list
means there are no substantively different executable ideas; explain why. Do not plan a fixed
number of rounds, execute tools, or produce the final material design here."""
DESIGN = """You are the creative material designer. Develop the assigned hypothesis into a
concrete, simple laboratory candidate. Include composition, structure, active sites, preparation,
proposed mechanism, operating conditions, recovery, reuse and limitations. Respect every user
constraint. Distinguish supplied evidence from domain-knowledge hypotheses. Do not fabricate
measurements or citations. Do not assess your own candidate or use tools."""
ASSESS = """Independently assess only the assigned perspective of the supplied candidate.
Use the given criteria. Give a score from 1 to 10, concise evidence, uncertainties and actionable
improvements. Estimated performance is not measured performance. Do not use tools or other
assessors' conclusions."""

AGGREGATE = """Cross-validate the supplied independent assessments. Explain agreement,
disagreement, weaknesses, uncertainty and actionable improvements. The numeric weighted score
is calculated by Python; do not replace it. Do not invent absent evidence or use tools."""
PROPAGATE = """Summarize the supplied completed child results and reusable lessons for this
research direction. Preserve negative findings and uncertainty, distinguish assessed hypotheses
from measurements, and identify useful next questions. Do not invent results for pending nodes.
Update priorSummary with the supplied changed/recent/best branches; omitted branches are not new failures.
For isRoot, also recommend the current most promising candidate, its advantages and risks,
and the first experiments and controls. Clearly separate evidence from hypotheses.
Keep the summary under 400 words. Do not use tools."""
# Established assessment dimensions, without the old Subagent output envelope.
CRITERIA = {
    "activity": """# Rubric: Assessment Screening Agent A — Catalytic Activity

Expert A evaluates water treatment material designs from the **catalytic activity and reaction mechanism** perspective.

## Core Responsibilities

1. Evaluate catalytic activity and reaction efficiency
2. Analyze the rationality of reaction mechanisms
3. Assess the scientific validity of active site design
4. Predict catalytic performance in practical applications

## Evaluation Dimensions

### 1. Catalytic Activity

- Active site density and distribution
- Relationship between electronic structure and catalytic activity
- Surface reaction kinetics
- Catalytic efficiency prediction

### 2. Reaction Mechanism

- Radical generation mechanisms (•OH, SO4•-, •O2-, etc.)
- Electron transfer pathways
- Reaction intermediate analysis
- Rate-limiting step identification

### 3. Selectivity

- Selective degradation of target pollutants
- By-product reaction suppression
- Product selectivity

### 4. Efficiency

- Catalyst activation efficiency
- Energy conversion efficiency
- Pollutant degradation rate

## Scoring Criteria

Each dimension receives a 1-10 score:

- **9-10**: Excellent, far exceeds industry standards
- **7-8**: Good, meets or exceeds industry standards
- **5-6**: Adequate, basically meets requirements
- **3-4**: Needs improvement, significant deficiencies
- **1-2**: Unqualified, requires redesign""",
    "stability": """# Rubric: Assessment Screening Agent B — Stability

Expert B evaluates water treatment material designs from the **structural stability and durability** perspective.

## Core Responsibilities

1. Evaluate structural stability of the material
2. Analyze durability under various conditions
3. Assess cycling performance
4. Predict material lifespan

## Evaluation Dimensions

### 1. Structural Stability

- Crystal structure stability
- Thermal stability
- Chemical stability
- Mechanical strength

### 2. Durability

- Acid-base resistance
- Redox resistance
- Anti-leaching performance
- Anti-poisoning performance

### 3. Recyclability

- Activity retention rate after multiple cycles
- Structural change analysis
- Regeneration method feasibility

### 4. Long-term Stability

- Aging mechanism analysis
- Deactivation prediction
- Service life estimation

## Scoring Criteria

Each dimension receives a 1-10 score:

- **9-10**: Excellent, far exceeds industry standards
- **7-8**: Good, meets or exceeds industry standards
- **5-6**: Adequate, basically meets requirements
- **3-4**: Needs improvement, significant deficiencies
- **1-2**: Unqualified, requires redesign""",
    "sustainability": """# Rubric: Assessment Screening Agent C — Environmental Safety

Expert C evaluates water treatment material designs from the **environmental safety and sustainability** perspective.

## Core Responsibilities

1. Evaluate environmental friendliness of the material
2. Analyze ecotoxicity risks
3. Assess sustainability
4. Predict environmental impact

## Evaluation Dimensions

### 1. Environmental Safety

- Material toxicity
- Degradation product toxicity
- Secondary pollution risk
- Ecological safety

### 2. Sustainability

- Raw material availability
- Environmental impact of production process
- Energy consumption assessment
- Carbon footprint analysis

### 3. Disposal

- Material recyclability
- Safe disposal methods
- Resource recovery potential

### 4. Full Lifecycle

- Production phase impact
- Use phase impact
- Disposal phase impact
- Comprehensive environmental benefit

## Scoring Criteria

Each dimension receives a 1-10 score:

- **9-10**: Excellent, environmentally friendly, strong sustainability
- **7-8**: Good, minimal environmental impact
- **5-6**: Adequate, environmental impact acceptable
- **3-4**: Needs improvement, environmental risks exist
- **1-2**: Unqualified, significant environmental risks""",
}

DEFAULTS = {"design": DESIGN, "aggregate": AGGREGATE, "propagate": PROPAGATE,
            **{role: ASSESS for role in CRITERIA}}
