# Scientific MCP and Skills: connect resources and reuse research methods

Research needs concrete evidence: a protein annotation, a paper's experimental conditions, or atom positions in a structure file. Model knowledge alone cannot reliably keep that information current and inspectable. Without suitable procedures, even good data can lead to results that are difficult to reproduce.

ScienceDiscovery connects scientific data and tools through MCP and supplies reusable methods through Skills. Connectors obtain actual records; Skills guide retrieval, organization, computation, and delivery, so each investigation need not start from scratch.

A useful shorthand separates the three extension concepts: **MCP is a tool, Skill is a method, and Specialist is a role.** MCP answers what the Agent can call, Skill answers how a kind of work should be done, and Specialist packages responsibility, Skills, and available tools into a role the main Agent can invoke.

## What the product already provides

ScienceDiscovery bundles common scientific connectors and composable Skills. Literature work can use sources such as PubMed, Europe PMC, and arXiv; structure work can use UniProt and PDB. Skills can cover retrieval, evidence extraction, computation, report writing, and result checks.

These presets help users get started quickly, but the inventory is not itself a Core concept. See [Built-in research capabilities reference](../reference/builtin-research-capabilities.md) for the complete version-sensitive list.

Bundled integration does not guarantee service availability, unrestricted downloads, or full-text access. An installed Skill also does not prove that the model read or used it in a particular run. Inspect the Session tool scope, execution record, and delivered artifacts.

![Scientific connectors](../../images/connector-en.png)

## Bring your laboratory's resources into the workflow

Connect a private database, an existing MCP service, or a specialized computing interface. Package recurring SOPs, analysis scripts, and delivery standards as Skills. Tools and methods can evolve separately: changing a data interface need not rewrite the whole procedure, and improving a procedure need not add a service.

User extension paths include local STDIO and remote HTTP/SSE MCP servers, plus skill imports from files, folders, ZIPs, and Git. An Agent can draft a Skill for human confirmation. Manage credentials in settings rather than public skill instructions.

The advanced guides provide the actual setup steps:

- [Connect custom MCP servers](../advanced-setup/configure-custom-mcp.md): services, authentication, connection tests, and tool selection.
- [Import and manage Skills](../advanced-setup/configure-skills.md): packages, import, availability, and verification.
- [Create Specialists](../advanced-setup/configure-specialists.md): organize resources and responsibilities into research roles.
