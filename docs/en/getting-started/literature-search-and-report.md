# Search the literature and write a cited summary

Turn one narrow question into a short evidence summary: find studies through the built-in literature connectors, extract what each one reports, and get a report whose references you can open.

- **Time:** about 15–25 minutes. Most of it is the run; retrieval speed depends on the sources and your network.
- **You need:** a working task model, and network access from the machine that runs ScienceDiscovery to PubMed and Europe PMC.
- **Input:** no file. The question is in the prompt.
- **Skills and connectors:** the bundled `literature-searcher`, `evidence-extractor` and `report-writer` Skills; the PubMed and Europe PMC connectors.
- **You end with:** `biochar-yield-summary.md` among the Artifacts, plus the source list and evidence table it was built from.

This lesson follows [Analyze a dataset](analyze-a-dataset.md). For a full-length review that takes one to two hours, see the [migratory bird navigation case](../domains/literature-research.md).

## 1. Turn on the literature connectors

Create a Project, for example `biochar-evidence`, and open its Session. In the bar under the message box, open **Data connectors**. Under **Data sources**, turn on **PubMed** and **Europe PMC**.

A new Session enables only web access by default, so this step is what lets the Agent query the two literature databases. The choice applies to this Session; see [Runtime behavior](../reference/runtime-behavior.md#runtime-settings-and-inheritance) for Project and global defaults.

## 2. Attach the three Skills

All bundled Skills are available by default. To point the Agent at the three this lesson exercises, type `/` in the message box and choose `literature-searcher`; repeat for `evidence-extractor` and `report-writer`. Each appears as a chip in the message box. Naming them in the prompt, as below, also works.

## 3. Send the task

```text
Write a short, cited evidence summary on this question:
Does adding biochar to soil increase crop yield, and does the effect depend on soil pH?

Work in three steps:
1. With literature-searcher, find 6 to 10 relevant studies in PubMed and Europe PMC, preferring meta-analyses and field trials. Record the queries you ran.
2. With evidence-extractor, record for each study its design, crops, soil pH range and reported yield effect, with the source of each row.
3. With report-writer, write biochar-yield-summary.md: a one-paragraph answer, the evidence table, where the studies disagree, and limitations. Every factual sentence needs an inline citation that points to a reference with a DOI or URL.

Keep it short: this is an evidence summary, not a full review. Declare biochar-yield-summary.md as an artifact and name it in your final reply.
```

## 4. Approve connector searches

Each new kind of action pauses on a **Permission required** card. Here the cards name the connector tool and the query, for example `mcp__pubmed__search` with the search terms, and later the first code execution. Several cards can arrive at once because searches run in parallel. **Allow same type** approves one tool for the rest of the Session; you approve each connector tool once.

## 5. What you should see

The exact studies, numbers and wording depend on the model and on what the databases return that day. Expect this shape:

- A plan or to-do list, then the work split into **Subagents** cards: a search, an extraction and a writing step, each run by a built-in Specialist of the same name as the Skill. Open a card to see its own tool calls.
- Search calls to PubMed and Europe PMC in the timeline. A query that returns nothing is normal; the Agent usually rephrases it.
- Intermediate Artifacts such as a source list and an evidence table, then `biochar-yield-summary.md`.
- A report with a short answer, a table with one row per study, a section on disagreement, limitations, and a numbered reference list whose entries carry a DOI or a PubMed or Europe PMC link.
- Usually a remark that some evidence comes from abstracts only. Search results and abstracts are not full papers; the summary should not claim it read text it did not retrieve.
- A Reviewer card a minute or so after the report is registered, often listing claims whose evidence is not yet linked. The [last lesson](trace-a-result.md) shows how to act on such findings.

## 6. Check your result

- [ ] The timeline shows searches against PubMed or Europe PMC that you approved.
- [ ] `biochar-yield-summary.md` is listed among the Artifacts.
- [ ] Every row of the evidence table names a source, and the references open to real records.
- [ ] Open two or three references and confirm they say what the summary attributes to them.

The last check is the important one. A well-formed citation does not prove that the source supports the sentence; see [ScienceMemory and Reviewer](../core/science-memory-reviewer.md).

If the Agent reports that a connector is unavailable, check the **Data connectors** selection and the network of the machine running ScienceDiscovery. A source that could not be reached is a coverage gap, not evidence that no research exists.

## Next

Continue with [Use and write Skills](use-and-write-skills.md).
