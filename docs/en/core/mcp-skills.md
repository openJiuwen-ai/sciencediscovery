# Scientific MCP and Skills: access data and use it methodically

A research Agent needs access to real databases and computing tools, as well as a method for using them coherently. MCP connectors and Skills provide these complementary capabilities, helping turn a verbal request into concrete work.

## Bring external capabilities into the investigation

Through MCP, the Agent can call configured scientific interfaces to search papers, query database records, or retrieve tool-generated files. Each interface has its own parameters and results. The Agent should choose from capabilities actually available in the current session rather than assume every database is online.

A connector also helps preserve source identity. Titles, DOIs, database records, and the scope of accessible content determine what can reasonably be inferred next. An abstract is not a full paper, and a database match does not validate a conclusion.

![Scientific connectors](../../images/connector-en.png)

## Preserve a way of working

A Skill contains readable working instructions and supporting resources. A literature skill can guide query design, deduplication, coverage notes, and incremental saving. An analysis skill can prompt input inspection, justified method selection, and reproducible code delivery.

Skills may contain scripts and reference material. Selecting one does not execute its scripts or install dependencies automatically. The Agent reads relevant instructions and uses actual tools to perform the work. Recorded skill versions help establish which procedure a run used.

## Combine tools and methods into reusable steps

In literature research, a Skill guides retrieval and organization, MCP supplies actual sources, and the Agent reads evidence, synthesizes findings, and delivers a report. A Skill cannot manufacture data when a connector is unavailable. Many interfaces without a clear method can also lead to duplicate searches and missed evidence.

Begin with an available connector and a suitable Skill, then add capabilities as needed. Project and Session choices determine actual availability. Registration in the global library does not guarantee access in a restricted session.

## Keep improvements reviewable

Settings support connector management and imports of local or Git skill packages. The Agent can also draft a Skill. User confirmation is required before an Agent-generated draft is installed, allowing useful experience to become reusable while retaining an opportunity to review changes.

External results and imported material still need to be handled according to their sources and permissions. MCP access and Skill selection do not bypass runtime permissions or guarantee complete research coverage.

- [Configure custom MCP servers](../advanced-setup/configure-custom-mcp.md): connections, credentials, and tool selection.
- [Skill management](../developer-docs/skill-library-management.md): packages, versions, and review.
- [Specialists](specialists.md): organize tools and methods into reusable roles.
