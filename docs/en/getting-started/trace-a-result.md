# Trace a result

A result is only as useful as your ability to check it. In this lesson you start from the figure and report of [Analyze a dataset](analyze-a-dataset.md), follow them back to the code, environment and input that produced them, act on the Reviewer's findings to get a second version, and revoke the permission you granted.

- **Time:** about 15 minutes, including one short run.
- **You need:** the Session from [Analyze a dataset](analyze-a-dataset.md), with `growth-report.md` and `treatment-boxplot.png` among its Artifacts.
- **Skills and connectors:** none.
- **You end with:** version 2 of `growth-report.md` alongside the unchanged version 1, and the code-execution grant from that lesson revoked.

The [Review and provenance](../developer-docs/review-provenance.md) design page explains what is recorded and why.

## 1. Open the provenance of the figure

Open the Session and, in the **Artifacts** list, open `treatment-boxplot.png`. Switch from **Preview** to **Provenance**. You should see:

- the command that produced the figure, typically a run of the analysis script, with **Download script**;
- the **Execution log** with the exit code and the output the script printed;
- the **Working directory** and, collapsed, the **Process environment** the command ran with;
- the **Managed package environment**, listing the exact package versions, such as pandas, SciPy and Matplotlib, that the run used.

These are records of what ran, not a description written by the model.

## 2. Check where a workspace file came from

In the **Workspace** panel, under **Files**, select the information icon next to `plant-growth.csv`, then next to `treatment-boxplot.png`. The first shows **User upload** as its origin; the second shows the tool and execution that wrote it, the **Linked Artifacts** and its **Revision history**.

## 3. Read the Reviewer's findings

The Reviewer and automatic review are on by default for new installations. About a minute after `growth-report.md` was registered, a Reviewer card appeared in the conversation. Open it. Typical findings at the quick level name numbers in the report that are not linked to recorded evidence, with a suggestion to add that link.

Findings do not change the Artifact. They are prompts for you and the Agent; the Reviewer can also be wrong. To turn automatic review off for a Session, use **Automatic review** next to the approval mode under the message box.

## 4. Ask for a revision

Send:

```text
The Reviewer card lists numbers in growth-report.md that are not linked to recorded evidence. Add a short "Where the numbers come from" section that names, for each table and test, the script and results file that produced it, and link the flagged values to those records. Do not rerun the analysis or change any number. Save the file and declare growth-report.md again so it becomes version 2 of the same artifact.
```

What you should see: the Agent reads the report and earlier records, edits the file, and declares it again. The Artifact's **version** selector now lists two versions, and its preview shows **v2 of 2**; the conversation mentions the new version. A new automatic review may follow, and it may still have findings.

## 5. Compare the versions

Open `growth-report.md`. In the **version** selector at the top of the Artifact, choose version 2; the preview shows **v2 of 2** and the new "Where the numbers come from" section. Then choose version 1 in the same selector and look at the same tables. A Markdown report has no side-by-side diff view, so compare the two previews yourself: version 2 adds the new section and links, and every value in the tables and test results should be unchanged, because the prompt asked for links, not new calculations. Both versions remain stored; version 1 still shows the original text and its own provenance.

## 6. Revoke the permission you granted

In the dataset lesson you chose **Allow same type** for code execution, which left a standing grant. Open **System configuration → Permissions**. Under **Standing permission grants**, each grant shows its action, such as **Run local code**, and the resource it covers, such as `workspace-code`. Select **Revoke** on the code-execution grant. Each Session where you chose **Allow same type** has its own grants, including one per connector tool from the earlier lessons; revoke those you no longer need. Revoking removes a grant from the list; executions that already ran keep their records and provenance.

## 7. Check your result

- [ ] The figure's **Provenance** tab shows the command, its exit code and the package versions it ran with.
- [ ] `plant-growth.csv` shows **User upload** as its origin.
- [ ] The **version** selector of `growth-report.md` lists two versions; version 2 adds the new section, and its values match version 1.
- [ ] **Standing permission grants** no longer lists the grants you revoked.

## Where to go next

You have completed the learning path. Apply it to a real research question with the [domain guides](../README.md#domain-guides), or read [ScienceMemory and Reviewer](../core/science-memory-reviewer.md) to follow results through the memory graph when it is enabled.
