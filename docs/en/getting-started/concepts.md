# Concepts: how ScienceDiscovery completes a research task

Before using ScienceDiscovery, understand a few basic concepts. The Core capabilities section then explains the research-specific capabilities built on top of a general Agent system.

## How a task runs

A ScienceDiscovery task can be viewed as:

```
Research question
      ↓
Research Agent
      ↓
Understand goal, plan steps, select capabilities
      ↓
Call tools, execute code, collaborate with roles
      ↓
Create research Artifacts
      ↓
Review, reuse, and continue research
```

The Agent does not only generate text. It works toward a goal by understanding the problem, selecting methods, executing actions, and delivering results.

## The Agent Loop

A typical Agent run includes:

1. Understand the objective and current context;
2. Decide what information or action is needed next;
3. Call tools, execute code, or ask other roles for help;
4. Adjust based on execution results;
5. Deliver an answer and research artifacts.

The execution timeline shows what actually happened during a task.

## What capabilities can an Agent use?

Three extension concepts are easy to confuse:

| Concept | Purpose | Simple view |
| --- | --- | --- |
| MCP | Provides external tools and data interfaces | Agent tools |
| Skill | Provides reusable methods and workflows | Agent methods |
| Specialist | Provides focused responsibilities and roles | Agent roles |

For example:

- MCP can let an Agent query a literature database;
- a Skill can guide a literature-review workflow;
- a Specialist can define a dedicated research role.

## Workspace, Artifacts, and research delivery

Files created during research have different purposes.

```
Workspace
  ├── Uploaded data
  ├── Temporary code
  ├── Intermediate results
  ↓
Artifact
  ├── Reports
  ├── Code
  ├── Tables
  └── Images
```

A useful shorthand:

> Workspace is the workbench; Artifact is the deliverable.

Not every file needs to become an Artifact. Results worth inspecting, downloading, reusing, or continuing should be delivered as Artifacts.

## Execution environment

The Agent needs a place to perform real work.

ScienceDiscovery provides a research execution environment where the Agent can:

- run Python, R, and Shell;
- analyze data;
- preserve scripts and results;
- execute computation inside a controlled environment.

The execution environment determines where work happens; Artifacts determine what remains as a result.

## From basic concepts to research capabilities

After understanding these foundations, continue with:

- [Core capabilities](../core/README.md): why ScienceDiscovery is designed for research workflows.
- [Domain guides](../domains/literature-research.md): see complete workflows through real tasks.
