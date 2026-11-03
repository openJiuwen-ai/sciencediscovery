# End-to-end walkthrough

From a dataset to a traceable conclusion. This page walks one complete path straight after installation: run a statistical analysis on the sample data shipped with the repository, add external literature evidence, let the Reviewer review it and accept a revision driven by its findings, trace where every number came from, and finally turn the workflow into a reusable Skill.

By the end you will see what separates ScienceDiscovery from a chat tool: not "can it answer", but that **every step can be checked and reused**. The whole thing takes about an hour, most of it run time.

- **You need:** a running ScienceDiscovery (see [Install and deploy](deployment.md)) and at least one model provider API key.
- **Sample used:** [`plant-growth.csv`](../../examples/plant-growth.csv), synthetic plant-growth data shipped with the repository; see [the sample data notes](../../examples/README.md).

## Setup: configure a task model

Open **System settings → Model registry**:

1. choose a preset provider or add one manually;
2. enter the provider details and API key;
3. select **Save & connect**;
4. confirm the connection test passes and choose a **Global default task model**.

The key here is your model provider API key. If the connection test fails, first check the API key, provider URL, model ID, and network connection.

Also check the code-execution environment: open **System settings → Local Runner → Scientific environments** and confirm the Python base environment shows **Ready**. A new data directory prepares it in the background after the first start; while it shows **Installing**, wait before you send anything. This walkthrough needs pandas, SciPy and Matplotlib, which the managed environment already includes.

## 1. Get the data running

Create a Project, for example `plant-growth`, and open its Session. In the **Workspace** panel on the right, drop [`plant-growth.csv`](../../examples/plant-growth.csv) onto **Drop files**, or click that area to choose the file. The file appears under **Files** and among the **Artifacts** as a user upload.

Paste the prompt below into the message box and send it:

```text
Analyze the uploaded file plant-growth.csv. It records the dry mass of 45 plants grown under three fertilizer treatments.

1. Load the file with pandas and report how many plants each treatment has.
2. Summarize dry_mass_g per treatment (n, mean, standard deviation) as a table.
3. Test whether mean dry_mass_g differs between treatments with a one-way ANOVA (scipy.stats.f_oneway), then compare the pairs with Tukey HSD (scipy.stats.tukey_hsd). Report the statistics and p-values.
4. Draw a box plot of dry_mass_g by treatment with the individual plants overlaid, and save it as treatment-boxplot.png.
5. light_hours also varies between plants. Check whether it is balanced across treatments and say whether it could explain the differences.
6. Write growth-report.md with the table, the test results, the figure and a short limitations section.
7. Declare growth-report.md and treatment-boxplot.png as artifacts and name them in your final reply.

Use the managed Python environment, which already has pandas, SciPy and Matplotlib, and run every calculation; do not estimate numbers in the reply.
```

With the default approval mode, **Ask for dangerous actions**, the first command pauses on a **Permission required** card for **Run local code**:

- **Allow once** approves this command only; the next command asks again.
- **Allow same type** approves this and later code executions, so the rest of the analysis runs without stopping.
- **Deny** refuses it, and the Agent has to continue without running code.

Choose **Allow same type** here. The code still runs inside the sandbox, with only the workspace and no network. This is a standing grant; step 5 shows how to revoke it.

**What you should see:** the timeline shows the Agent listing and reading the file, then several code executions; a failed execution followed by a corrected one is normal. `growth-report.md` and `treatment-boxplot.png` appear among the **Artifacts**, often with the analysis script and a results file beside them. Opening the report shows a table with 15 plants per treatment, the ANOVA statistic and p-value, pairwise comparisons between the three treatments, the figure or a reference to it, and a limitations paragraph. In this sample `light_hours` is not perfectly balanced across treatments, so a careful report discusses it instead of ignoring it.

> Different models write different code and prose; expect the shape of the result, not particular numbers or wording.

## 2. Add external evidence

This step brings in knowledge from outside the data: query the literature databases and get an evidence summary whose references you can open one by one.

In the bar under the message box, open **Data connectors** and turn on **PubMed** and **Europe PMC** under **Data sources**. A new Session enables only web access by default, so this is what lets the Agent query the two literature databases.

Then type `/` and choose `literature-searcher`, `evidence-extractor` and `report-writer`; each appears as a chip in the message box, and naming them in the prompt works as well. Send:

```text
Write a short, cited evidence summary on this question:
Does adding biochar to soil increase crop yield, and does the effect depend on soil pH?

Work in three steps:
1. With literature-searcher, find 6 to 10 relevant studies in PubMed and Europe PMC, preferring meta-analyses and field trials. Record the queries you ran.
2. With evidence-extractor, record for each study its design, crops, soil pH range and reported yield effect, with the source of each row.
3. With report-writer, write biochar-yield-summary.md: a one-paragraph answer, the evidence table, where the studies disagree, and limitations. Every factual sentence needs an inline citation that points to a reference with a DOI or URL.

Keep it short: this is an evidence summary, not a full review. Declare biochar-yield-summary.md as an artifact and name it in your final reply.
```

Each new kind of action pauses on a **Permission required** card naming the connector tool and the query, for example `mcp__pubmed__search`. Searches run in parallel, so several cards can arrive at once; choose **Allow same type** once per connector tool.

**What you should see:** a plan or to-do list, then the work split into **Subagents** cards — a search, an extraction and a writing step, each run by a built-in Specialist of the same name as the Skill. The timeline shows search calls to PubMed and Europe PMC; a query that returns nothing is normal, and the Agent usually rephrases it. Intermediate artifacts (a source list, an evidence table) are followed by `biochar-yield-summary.md`, with a short answer, a table with one row per study, a section on disagreement, limitations, and a numbered reference list.

Open two or three references and confirm they say what the summary attributes to them. A well-formed citation does not prove that the source supports the sentence, which is what the next step is about.

## 3. Connect an MCP tool

ScienceDiscovery can also reach external tools you choose over MCP. This step uses a public server that needs no installation, account or key, to check the statistical method that step 1 relied on.

Open **System settings → MCP servers → Custom** and choose **Add server**:

| Field | Value |
| --- | --- |
| Name | `DeepWiki` |
| Transport | Streamable HTTP |
| URL | `https://mcp.deepwiki.com/mcp` |
| Authentication | None / request headers, with no headers |

Tick **Enable this MCP server**, select **Save**, then click the server name to expand it and select **Test connection**. Once the status is **Connected**, open **Data connectors** under the message box and turn on **DeepWiki** under **Custom MCP** for the current Session — enabling a server in settings does not give every Session its tools.

Send:

```text
Use the DeepWiki connector to look at the scipy/scipy repository on GitHub.

1. Find where scipy.stats.tukey_hsd is implemented and which distribution it uses for its p-values and confidence intervals.
2. Note what it assumes about the groups, such as equal variances or equal sample sizes.
3. Write tukey-hsd-notes.md with a short explanation, the source file paths DeepWiki reported, and a caveat that DeepWiki's answers are generated summaries to be checked against the code.

Declare tukey-hsd-notes.md as an artifact and name it in your final reply.
```

The first call to each DeepWiki tool pauses on a **Permission required** card; choose **Allow same type** for each, and approve the code execution that writes the file.

**What you should see:** tool calls to the DeepWiki tools in the timeline, where expanding one shows the question the Agent sent and the answer it received; and `tukey-hsd-notes.md` among the Artifacts, naming the implementation file, the distribution and the assumptions. DeepWiki is a third-party service whose answers are generated summaries of the code, so send it nothing private. For servers that need credentials, OAuth or a local command, see [Configure custom MCP servers](../advanced-setup/configure-custom-mcp.md).

## 4. Let the Reviewer review and accept a revision

Return to the Session from step 1. About a minute after `growth-report.md` is registered, a Reviewer card usually appears in the conversation; typical findings at the quick level name numbers in the report that are not linked to recorded evidence. Findings do not change the Artifact — they are prompts for you and the Agent, and the Reviewer can also be wrong. To turn automatic review off for a Session, use **Automatic review** next to the approval mode under the message box.

First have a bundled Skill check the work independently. Type `/` in the message box, choose `computation-reviewer`, and send:

```text
Check growth-report.md against the code executions recorded in this Session. For each number in its tables and test results, say which execution produced it, and list any number you cannot trace to an execution. Do not change the report. Write the check to computation-check.md and declare it as an artifact.
```

`computation-check.md` appears among the Artifacts as a table that pairs each number in the report with the execution behind it, plus anything it could not match; `growth-report.md` itself is unchanged. A Skill being available does not prove the model used it — the timeline entry that loads the Skill is the evidence.

Then ask for the revision the Reviewer pointed at:

```text
The Reviewer card lists numbers in growth-report.md that are not linked to recorded evidence. Add a short "Where the numbers come from" section that names, for each table and test, the script and results file that produced it, and link the flagged values to those records. Do not rerun the analysis or change any number. Save the file and declare growth-report.md again so it becomes version 2 of the same artifact.
```

**What you should see:** the Agent reads the report and earlier records, edits the file, and declares it again. The Artifact's **version** selector now lists two versions and its preview shows **v2 of 2**.

## 5. Trace the results

Reviewing is only half of it; you also need to answer "where did this number come from". Open `treatment-boxplot.png` and switch from **Preview** to **Provenance**:

- the command that produced the figure, typically a run of the analysis script, with **Download script**;
- the **Execution log** with the exit code and the output the script printed;
- the **Working directory** and, collapsed, the **Process environment** the command ran with;
- the **Managed package environment**, listing the exact package versions, such as pandas, SciPy and Matplotlib, that the run used.

These are records of what ran, not a description written by the model. In the **Workspace** panel, under **Files**, select the information icon next to [`plant-growth.csv`](../../examples/plant-growth.csv) to see **User upload** as its origin, then next to `treatment-boxplot.png` to see the tool and execution that wrote it, the **Linked Artifacts** and its **Revision history**.

Back in `growth-report.md`, compare the two versions in the **version** selector at the top of the Artifact: version 2 adds the "Where the numbers come from" section, and every value in the tables and test results should be unchanged, because the prompt asked for links, not new calculations. Both versions remain stored, and version 1 still shows the original text and its own provenance.

Finally, revoke the standing grant from step 1: open **System settings → Permissions** and, under **Standing permission grants**, select **Revoke** on the **Run local code** grant. Each Session where you chose **Allow same type** has its own grants, including one per connector tool from the earlier steps; revoking removes a grant from the list, and executions that already ran keep their records and provenance.

## 6. Turn the workflow into a Skill

An analysis worth repeating should become a Skill. In the Session from step 1, start the message with `/skill-creator`; the composer shows it as a **Skill authoring** command. Send:

```text
/skill-creator Create a Skill named group-comparison from the analysis in this Session. It should compare one numeric column between the groups of another column in an uploaded CSV: report n, mean and standard deviation per group, run a one-way ANOVA and Tukey HSD with SciPy in the managed Python environment, draw a box plot with the individual points overlaid, and write a Markdown report that is declared as an artifact together with the figure. The user names the CSV file and the two columns.
```

The Agent writes a package with a `SKILL.md`, a script and often a report template, tests the script on [`plant-growth.csv`](../../examples/plant-growth.csv) in the sandbox, and finishes by creating a **pending draft**. Nothing is installed yet.

Open **System settings → Skills**, open the draft and read **Review changes**: the `SKILL.md` instructions, the script and any other file can all be edited, which is the point of the review. Leave **Publish to** at **Project Skills** and select **Publish Skill**. Published library Skills reach a run only where their library is turned on, so open the Project's menu in the left sidebar, choose **Settings**, turn on **Project Skills** under **Skill libraries**, and save.

Create a new Session in that Project, upload [`plant-growth.csv`](../../examples/plant-growth.csv) again as in step 1, and send:

```text
Use group-comparison on plant-growth.csv to compare light_hours between the treatment groups.
```

Approve the first code execution as before. The timeline shows the Agent reading the `group-comparison` Skill and running its bundled script on the file, with `treatment` as the group column and `light_hours` as the value; a report, a box plot and a results file appear among the Artifacts, named after the column the Skill compared. To import a Skill you already have instead of writing one, see [Import and manage research Skills](../advanced-setup/configure-skills.md).

## Check your result

- [ ] The timeline contains code executions you approved, PubMed or Europe PMC searches, and DeepWiki tool calls.
- [ ] The Artifacts include `growth-report.md`, `treatment-boxplot.png`, `biochar-yield-summary.md`, `tukey-hsd-notes.md` and `computation-check.md`.
- [ ] The figure's **Provenance** tab shows the command, its exit code and the package versions it ran with.
- [ ] The **version** selector of `growth-report.md` lists two versions; version 2 adds the new section, and its values match version 1.
- [ ] In the new Session, the report produced by `group-comparison` compares `light_hours`, not `dry_mass_g`.
- [ ] **Standing permission grants** no longer lists the grants you revoked.

Wording and numbers differ between runs; that is expected. What matters here is that the tools actually ran, the evidence is traceable, and the workflow is reusable.

## Where to go next

- To apply this path to a real research question, see [Domain guides](../README.md#domain-guides).
- To understand why ScienceDiscovery suits research, see [Core capabilities](../README.md#core-capabilities).
- For a concrete optimization walkthrough, see [Use PUCT to optimize a text compression algorithm](../domains/evolve-a-solution.md).
- To read what tracing records and why, see [Review and provenance](../developer-docs/review-provenance.md).
