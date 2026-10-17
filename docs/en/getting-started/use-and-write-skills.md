# Use and write Skills

A Skill is a reusable method: instructions, and optionally scripts and references, that the Agent loads when a task needs them. In this lesson you point the Agent at a bundled Skill, then turn the analysis from [Analyze a dataset](analyze-a-dataset.md) into a Skill of your own and run it on the same file.

- **Time:** about 25 minutes, most of it in three runs of a few minutes each.
- **You need:** the Session from [Analyze a dataset](analyze-a-dataset.md), with `growth-report.md` among its Artifacts, and `plant-growth.csv`.
- **Skills:** the bundled `computation-reviewer` and `skill-creator`, then the `group-comparison` Skill you create.
- **You end with:** `computation-check.md`, a published `group-comparison` Skill, and a report it produced in a new Session.

All 17 bundled Skills, with what each one is for, are listed in [Built-in research capabilities](../reference/builtin-research-capabilities.md#built-in-skills).

## 1. Use a bundled Skill

Go back to the Session from the dataset lesson. Type `/` in the message box, choose `computation-reviewer` so it appears as a chip, and send:

```text
Check growth-report.md against the code executions recorded in this Session. For each number in its tables and test results, say which execution produced it, and list any number you cannot trace to an execution. Do not change the report. Write the check to computation-check.md and declare it as an artifact.
```

What you should see: the timeline shows the Agent loading `computation-reviewer`, reading the report, looking up earlier executions and their logs, and usually re-running small checks. `computation-check.md` appears among the Artifacts as a table that pairs each number in the report with the execution behind it, plus anything it could not match. `growth-report.md` itself is unchanged.

A Skill being available does not prove the model used it. The timeline entry that loads the Skill is the evidence.

## 2. Create a Skill with skill-creator

In the same Session, start the message with `/skill-creator`. The composer shows it as a **Skill authoring** command. Send:

```text
/skill-creator Create a Skill named group-comparison from the analysis in this Session. It should compare one numeric column between the groups of another column in an uploaded CSV: report n, mean and standard deviation per group, run a one-way ANOVA and Tukey HSD with SciPy in the managed Python environment, draw a box plot with the individual points overlaid, and write a Markdown report that is declared as an artifact together with the figure. The user names the CSV file and the two columns.
```

What you should see: the Agent loads `skill-creator`, writes a package with a `SKILL.md`, a script and often a report template, and tests the script on `plant-growth.csv` in the sandbox. It finishes by creating a **pending draft**. Nothing is installed yet.

## 3. Review and publish the draft

Open **System configuration → Skills**. The Skill manager shows a pending review for `group-comparison`; the conversation also offers a shortcut to it.

1. Open the draft and read **Review changes**: the `SKILL.md` instructions, the script, and any other file. Edit anything you disagree with; this is the point of the review.
2. Leave **Publish to** at **Project Skills** and select **Publish Skill**.

Publishing creates an immutable version in the Project Skills library. **Discard draft** removes the proposal instead.

## 4. Make the library available to a Project

Published library Skills reach a run only where their library is turned on. In the left sidebar, open the menu of the Project from the dataset lesson, choose **Settings**, turn on **Project Skills** under **Skill libraries**, and save the Project settings.

## 5. Run your Skill

Create a new Session in that Project, upload `plant-growth.csv` again as in [Analyze a dataset](analyze-a-dataset.md#3-upload-the-file), and send:

```text
Use group-comparison on plant-growth.csv to compare light_hours between the treatment groups.
```

Approve the first code execution as before. What you should see: the timeline shows the Agent reading the `group-comparison` Skill and running its bundled script on the file, with `treatment` as the group column and `light_hours` as the value. A report, a box plot and usually a results file appear among the Artifacts, named after the column the Skill compared.

## 6. Check your result

- [ ] The timeline shows `computation-reviewer` being loaded in step 1, and `computation-check.md` is an Artifact.
- [ ] The draft is no longer pending, and the Project's **Skill libraries** setting shows **Project Skills** with a published version.
- [ ] In the new Session, the timeline shows the Skill being read and its script running, and the report compares `light_hours`, not `dry_mass_g`.

If the new Session does not find `group-comparison`, check that **Project Skills** is on in that Project's or Session's settings. To import a Skill you already have instead of writing one, see [Import and manage research Skills](../advanced-setup/configure-skills.md).

## Next

Continue with [Connect a tool](connect-a-tool.md).
