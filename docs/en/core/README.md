# ScienceDiscovery Core Capabilities

Core does not explain basic Agent concepts. It answers a different question:

> What special capabilities does ScienceDiscovery add on top of a general Agent?

If you are new to Agent systems, first read [Basic concepts](../getting-started/concepts.md) to understand Agent loops, Tools, Skills, Specialists, Workspaces, and Artifacts.

ScienceDiscovery's differentiated capabilities fall into three areas.

## 1. Exploration and optimization: making research iterative

### [Idea Tree](idea-tree.md)

For open-ended questions, ScienceDiscovery can explore multiple candidate directions, design approaches, and use feedback to guide further investigation.

### [RSI for scientific artifacts](evolve.md)

For an evaluable artifact, ScienceDiscovery can generate candidates, assess them, and select improved versions through iterative optimization.

Idea Tree asks:

> What should we explore next?

RSI asks:

> How can the current solution become better?

---

## 2. Scientific trust: making results traceable and reviewable

### [ScienceMemory and Reviewer](science-memory-reviewer.md)

Research results need more than generation. They need answers to:

- Where did this conclusion come from?
- Which evidence supports it?
- Which parts need further review?

ScienceMemory records relationships across the research process. Reviewer helps identify issues in delivered artifacts.

---

## 3. Research execution foundation

These capabilities are the building blocks of an Agent workflow. Their role is introduced in Basic concepts; these pages describe ScienceDiscovery's implementation and usage.

### [Scientific execution environment and workspaces](execution-workspaces.md)

Provides code execution, file management, and research environments.

### [Scientific MCP and Skills](mcp-skills.md)

MCP connects external tools and data. Skills provide reusable research methods.

### [Specialists](specialists.md)

Packages responsibilities, methods, and tools into reusable research roles.

These capabilities answer:

> How does an Agent perform research tasks?

Idea Tree, RSI, ScienceMemory, and Reviewer answer:

> Why is ScienceDiscovery designed for scientific research?

## Where to go next

- Understand complete workflows: [Domain guides](../domains/literature-research.md)
- Extend capabilities: [Advanced setup](../advanced-setup/)
- Understand implementation: [Developer documentation](../developer-docs/)
