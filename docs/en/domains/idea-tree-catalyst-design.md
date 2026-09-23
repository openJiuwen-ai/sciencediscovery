# Explore water treatment catalysts with Idea Tree

This walkthrough explores catalysts for degrading pollutants in water: develop different designs, compare activity, stability, and sustainability, then choose directions for experimental validation.

The outputs are candidate proposals with assessment reasoning, risks, and suggested validation steps. See [Idea Tree](../core/idea-tree.md) for the feature overview.

## 1. Prepare the research question

Complete the [quick start](../getting-started/quick-start.md) and make sure the conversation model and Idea Tree backend are available. Retrieval also requires working literature or web search tools.

This example asks how to degrade tetracycline in near-neutral water. You can substitute another pollutant, but try to specify:

- Operating conditions, such as room temperature, near-neutral pH, and whether light or added oxidants are available.
- Material constraints, such as avoiding precious metals, minimizing toxic metal leaching, and enabling recovery.
- Existing evidence: papers, experimental records, or approaches you have already tried.

Upload any materials and ask the agent to read and summarize them. If you have none, start with retrieval. Ideas without supporting evidence should be identified as hypotheses.

## 2. Choose a template

Open **System settings → Idea Tree**, choose **Water treatment material design**, select **Standard** exploration intensity, and save.

The template assesses three perspectives: activity considers expected degradation performance; stability considers performance during use and reuse; sustainability considers cost, resources, and environmental impact.

## 3. Start exploration

Enter this in the conversation:

```text
/idea-tree Explore catalyst designs for degrading tetracycline in water.
Conditions: room temperature, near-neutral pH; visible light is available.
State explicitly if a design requires an added oxidant.
Constraints: no precious metals; consider metal leaching and material recovery.

First search and read relevant studies, summarize evidence, sources, and gaps,
then start exploration.
Compare material compositions and structures. Explain proposed mechanisms,
activity–stability tradeoffs, and the next validation steps.
Do not treat published measurements as performance of a new proposal,
and do not invent experimental results.
```

The agent prepares the evidence and hands it to Idea Tree. After launch is confirmed, click **View research progress** on the Idea Tree card.

If you have already supplied sufficient evidence, you can add: “Use only my supplied materials and skip external retrieval.”

## 4. Follow how proposals improve

Select a candidate node and read its design, three assessments, and summary. Look for:

- What changed: composition, structure, or recovery method?
- Why might it work: which material supports the reasoning, and what remains a hypothesis?
- What problems did assessment identify: poor stability, demanding operating conditions, or missing evidence?
- Does the next proposal address those problems, and does it introduce another cost?

For example, difficulty recovering a candidate might lead to a later proposal that immobilizes it on a support. Compare the expected recovery benefit with any possible loss of activity. This illustrates how to read the tree; actual branches depend on the research run.

Click **Pause** when needed and **Continue** when ready. Later chat messages do not automatically update research settings or materials. Start new research to change the goal or add evidence.

## 5. Choose what to validate next

After research finishes, ask in chat:

```text
Read this Idea Tree's results and compare up to three candidates worth
further validation. For each, explain the design differences, supporting
evidence, main risks, and the first question to test.
If the evidence is too weak to recommend a candidate, say what is missing.
```

Do not rely only on the overall score. A lower-scoring proposal with stronger evidence and an easier validation path may be a better next step.

You should be able to explain which design to test first, why, and what experimental result would make you revise or abandon it. Experiments should examine pollutant removal, degradation products, and material stability, among other questions. Model scores alone cannot establish treatment performance.

## Adapt the example

Replace the pollutant, operating conditions, and material constraints with your own. A focused question such as “How can I balance degradation activity with recoverability?” makes comparison easier than “Design the best catalyst.”
