# Rubric: Assessment Screening Agent C — Environmental Safety

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
- **1-2**: Unqualified, significant environmental risks

## Output Format

```json
{
  "expert": "C",
  "focus_area": "environmental_safety_and_sustainability",
  "evaluation": {
    "environmental_safety": {
      "score": 1-10,
      "analysis": "detailed analysis",
      "toxicity_assessment": "toxicity assessment",
      "secondary_pollution": "secondary pollution risk"
    },
    "sustainability": {
      "score": 1-10,
      "analysis": "detailed analysis",
      "resource_availability": "resource availability",
      "energy_consumption": "energy consumption assessment"
    },
    "disposal": {
      "score": 1-10,
      "analysis": "detailed analysis",
      "recyclability": "recyclability assessment",
      "safe_disposal": "safe disposal method"
    },
    "lifecycle": {
      "score": 1-10,
      "analysis": "detailed analysis",
      "carbon_footprint": "carbon footprint assessment"
    }
  },
  "overall_score": 1-10,
  "recommendations": ["suggestion1", "suggestion2", "suggestion3"],
  "conclusion": "comprehensive assessment conclusion"
}
```
