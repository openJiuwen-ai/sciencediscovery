# Idea Tree: explore research directions, then refine them

Sometimes the hardest research decision is what to try next. The first promising approach may not be the best, while considering several alternatives makes it easy to lose the reasoning behind each choice.

Idea Tree organizes that work into an inspectable research tree. It proposes candidate ideas, develops experimental plans, assesses them separately, and feeds the findings into the next round. You can follow how directions branch, which candidates improve, and why assessments change.

## Separate proposals from assessment

Each round starts with a batch of candidates and develops their designs. Different assessment roles produce judgments, which are then combined into scores and reasons. A proposal receives a dedicated examination instead of being declared successful in the same response that introduces it.

“Independent scoring” means separate role-based assessment steps, not independent scientific validation. Roles may use the same model and share biases. The benefit is making comparisons visible so that missing conditions and untested assumptions are easier to notice.

## Let feedback shape the next round

The tree retains candidates and completed stages. Later rounds can improve a promising direction or explore a new route suggested by feedback. Round, candidate, and depth budgets keep an open question from expanding indefinitely.

For example, several material-improvement proposals could be assessed for performance, stability, and sustainability. The default scoring dimensions follow these concerns. When changing domains, adjust role prompts and assessment priorities rather than treating default scores as a universal scientific measure.

## Leave with a plan you can test

Configure budgets and role prompts in Idea Tree settings, then start with `/idea-tree <research task>` or `/idea-tree-team <research task>`. The workspace tree panel shows candidates, stage results, and status, with pause, continue, and end controls.

The useful output is a candidate backed by reasons: what it addresses, how to test it, its assumptions, and the evidence still needed. Those findings can guide a subsequent literature review or sandbox experiment.

**Idea Tree currently does not retrieve external sources, execute code, or conduct real experiments.** Retrieval and material preparation come first; proposed experiments must be carried out afterward. Node scores are model assessments of supplied material, not measurements. The engine organizes exploration without replacing experiments.

- [Literature-research tutorial](../domains/literature-research.md): prepare checkable sources.
- [Scientific sandbox](execution-workspaces.md): turn a selected plan into code and computation.
- [Idea Tree implementation and limits](../developer-docs/idea-tree.md): saved stages, budgets, and recovery.
