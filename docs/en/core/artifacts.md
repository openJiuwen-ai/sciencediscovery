# Research Artifacts: make results reusable and reviewable

An Agent reply can explain a result, but chat alone is often insufficient for handoff, reproduction, or continued research. ScienceDiscovery registers useful files as Artifacts so reports, code, tables, images, and other research outputs become objects that can be inspected, downloaded, versioned, and reused.

The point of an Artifact is not merely that a file exists. It means: **this is a formal deliverable from the research task.**

## Workspace stores work; Artifact marks delivery

The Workspace contains files used throughout the research process, including:

- uploaded data;
- temporary code;
- intermediate outputs;
- downloaded material;
- final reports.

Not every file needs to be an Artifact. Register a result when it is worth inspecting, downloading, reviewing, or using as input to later work.

A useful shorthand is:

> Workspace is the workbench; Artifact is the deliverable.

A file being present in the Workspace and a result being delivered as an Artifact are therefore different states.

## An Artifact can be more than a final report

Different tasks may deliver:

- Markdown or PDF research reports;
- Python, R, or Shell scripts;
- CSV / JSON result tables;
- images and visualizations;
- model inputs, candidate designs, or other reusable files.

Strong deliveries often preserve enough process material alongside conclusions. A data-analysis task can deliver the script, key result table, and report together so review does not require reconstructing the method from chat history.

## Versions make changes inspectable

A research Artifact may change over several iterations. Version history helps answer:

- which revision produced the current result;
- what changed between two versions;
- what a Reviewer comment caused to be revised;
- how an RSI-selected result differs from its starting point.

Versioning does not prove that a newer revision is more correct. It provides comparable history; improvement still depends on evaluation, evidence, and experiments.

[RSI for scientific artifacts](evolve.md) builds directly on this idea by searching and comparing versions of an evaluable deliverable.

## Artifacts are the anchor for trust mechanisms

Several ScienceDiscovery capabilities converge on Artifacts:

- **Reviewer**: raises citation, computation, or evidence issues against a concrete Artifact version;
- **ScienceMemory**: records relationships among tasks, files, citations, and conclusions;
- **RSI**: compares and improves evaluable Artifact versions;
- **Domain workflows**: deliver real research cases as files rather than ending at a chat response.

Artifacts therefore form an important boundary between “the Agent did some work” and “the result can be inspected.”

## Artifact does not mean correct answer

Registering a file as an Artifact does not mean:

- every fact has been verified;
- the code is bug-free;
- citations support every claim;
- the statistical method fits the problem;
- the result has been peer reviewed.

Important conclusions still require checking their sources, computations, and applicability. Reviewer and ScienceMemory help locate issues but do not replace scientific validation.

## Where to inspect and reuse Artifacts

Artifacts are available from the Workspace artifact area. For file handoff, execution states, and remote Runner behavior, see [Execution and workspace reference](../reference/execution-workspaces.md).

Real examples show how Artifacts fit into the workflow:

- [Sepsis data analysis](../domains/analyze-sepsis-endotypes.md): from CSV to computation and delivery;
- [Literature research](../domains/literature-research.md): deliver a cited Markdown report;
- [Evolve a solution](../domains/evolve-a-solution.md): compare the starting and improved versions.

## Continue reading

- [Research Agent](research-agent.md): who produces and integrates these results.
- [Scientific execution environment and workspaces](execution-workspaces.md): how files are created during execution.
- [ScienceMemory and Reviewer](science-memory-reviewer.md): how artifacts are traced and reviewed.
- [RSI for scientific artifacts](evolve.md): how artifact versions are searched and compared.
