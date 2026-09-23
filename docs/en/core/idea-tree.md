# Idea Tree research exploration

Idea Tree develops several proposals for a research goal, assesses them, and uses what it learns to improve the next proposals. It keeps directions, candidates, and assessments in a tree so you can compare promising paths and see what still needs validation.

It suits questions such as “Which catalyst designs should I explore for degrading pollutants in water?” For a walkthrough, see [Explore water treatment catalysts with Idea Tree](../domains/idea-tree-catalyst-design.md).

## Start a research task

Enter `/idea-tree` in a conversation, followed by your goal, constraints, and available evidence. `/idea-tree-team` opens the same workflow.

The agent first searches and reads relevant sources, then prepares evidence, references, and uncertainties before starting Idea Tree. It uses existing material directly when that evidence is sufficient or you explicitly ask to skip retrieval.

Once started, research progresses independently. The end of the chat reply does not mean research has finished. Follow the Idea Tree card or ask about the current results in chat.

## What the tree represents

- The **research goal** is the question the whole tree addresses.
- **Direction nodes** organize approaches and summarize lessons from their candidates.
- **Candidates** are concrete proposals with designs, individual assessments, and overall scores.

Each round proposes a batch of candidates, develops and assesses them, and adds strengths, problems, and validation needs to the parent directions. Later rounds improve existing proposals or explore new directions while preserving earlier results. Not every branch continues, and candidates need not reach the same depth.

## Choose a template and exploration intensity

Open **System settings → Idea Tree**, select a template and intensity, and save. Changes apply to new research; an existing research task keeps its original settings.

| Research template | Assessment focus |
|---|---|
| General scientific hypothesis exploration | Scientific validity, evidence and validation readiness, feasibility and risk |
| Water treatment material design | Activity, stability, sustainability |

Choose **Quick**, **Standard**, or **Deep**. Quick gives an initial view of possible directions; Standard suits general exploration; Deep allows more branches and assessment rounds, usually taking more time and model usage. Research finishes when it reaches limits such as rounds or candidate count, or has no direction left to expand.

## Read scores alongside their reasons

The model assesses each candidate from the template's three perspectives on a 1–10 scale. The system calculates an overall score using the template's weights. Read the reasoning and evidence gaps before comparing scores.

A high score means a proposal looks promising under the current evidence and criteria. It is neither an experimental success probability nor a measured property: an activity score of 8 does not mean 80% pollutant degradation.

## View and control research

Click **View research progress** on the Idea Tree card to open the tree. Select a node to read its design, assessments, and summary.

- **Pause** waits for model requests already in flight to exit. Those requests may still incur usage.
- **Continue** resumes from saved progress. After a service restart or failed call, read the interruption reason and resolve it before continuing.
- **End** stops the research after confirmation and retains existing results. It cannot be resumed. Start new research to change the goal or materials.

Only one Idea Tree research task can run in a conversation at a time.

## Limits

Sources can be retrieved and prepared before launch. Exploration within the tree does not browse, execute code, or run experiments. Prepare additional evidence before starting a new research task.

The research engine currently requires a working Idea Tree backend and an OpenAI-compatible model with an API key configured for the conversation. Assessments depend on model judgment; repeated exploration does not replace experimental validation.

For executing analysis on existing data, reviewing results, and producing a report, see [Agent Team](agent-team.md).
