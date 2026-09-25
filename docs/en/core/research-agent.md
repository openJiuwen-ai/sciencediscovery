# Research Agent: from a question to an inspectable research process

ScienceDiscovery is not centered on a single response. Its Agent works toward a research objective over multiple steps: understand the problem, choose methods and tools, execute concrete work, inspect intermediate results, and deliver useful results as research artifacts.

You can begin with the goal rather than pre-authoring a rigid workflow. The Agent chooses actions from the current task, available tools, Skills, Specialists, and supplied material. Important actions still remain subject to permissions and runtime boundaries.

## The main Agent connects the research objective

The main Agent in a Session carries the current objective and context. It can:

- read messages and supplied files;
- use available MCP tools to obtain external data;
- load Skills as reusable working methods;
- run code in the scientific execution environment;
- delegate suitable work to Specialists / child Agents;
- synthesize results and produce Artifacts.

You therefore do not need to manually select every capability before asking a research question. Inspect the execution record to see what the Agent actually used.

## Child Agents divide work; they do not establish truth

Complex tasks can be split into relatively independent subtasks. A literature review may search different evidence areas in parallel; a data study may separate implementation from result evaluation.

Child Agents help by:

- separating task contexts;
- allowing some work to proceed in parallel;
- making responsibilities and deliveries clearer.

Agreement among several Agents is not independent scientific validation. Roles may share the same model, sources, or biases. Claims still need support from sources, computations, or experiments.

## What the Agent can call is determined by the Session

Capabilities visible to an Agent come from the runtime and Session configuration:

| Capability | What it answers |
| --- | --- |
| MCP | Which external tools, databases, and services can the Agent access? |
| Skill | Which reusable research methods can the Agent follow? |
| Specialist | Which role owns a type of work, with which methods and tools? |
| Scientific execution environment | Where can the Agent run Python, R, and Shell? |
| Artifact | Which results are formally delivered, versioned, and available for review? |

A useful shorthand is: **MCP is a tool, Skill is a method, Specialist is a role, and Artifact is a deliverable.**

Configuration defines what the Agent *can* do; it does not guarantee that a model will invoke a particular capability on every run. Use the timeline, tool calls, and artifacts as the record of actual behavior.

## A typical research flow

Suppose you ask:

> Review the main subtyping methods for a disease, compare the evidence, and perform an initial analysis on a local patient dataset.

The Agent may:

1. clarify scope and evidence needs;
2. use literature MCP tools to find sources;
3. apply literature-research Skills to organize evidence;
4. delegate parts of retrieval or extraction to Specialists;
5. run analysis code in the scientific execution environment;
6. compare literature evidence with computed results;
7. produce report, table, or script Artifacts;
8. if Reviewer / ScienceMemory are enabled, inspect and trace the delivered work.

This is not a fixed orchestration. Different tasks can produce different strategies; inspect the process and outputs rather than assuming a step always occurs.

## The researcher still controls direction

Automation can reduce repetitive work, but it does not replace judgment about goals, evidence, and methods. Intervene especially when:

- the research question is ambiguous;
- source or dataset boundaries are unclear;
- a high-impact permission is requested;
- intermediate work drifts from the objective;
- important claims lack inspectable support.

ScienceDiscovery aims to make more research steps executable and inspectable, not to make “autonomy” a substitute for scientific judgment.

## Continue reading

- [Scientific execution environment and workspaces](execution-workspaces.md): how code actually runs.
- [Scientific MCP and Skills](mcp-skills.md): where tools and methods come from.
- [Specialists](specialists.md): how responsibilities become reusable roles.
- [Research Artifacts](artifacts.md): how results become reusable and reviewable deliverables.
- [Literature-research guide](../domains/literature-research.md): see an end-to-end research process.
