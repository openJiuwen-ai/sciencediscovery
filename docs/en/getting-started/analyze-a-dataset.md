# Analyze a dataset

Upload a small CSV, ask a statistical question, approve the first code execution, and find a chart and a report among the Artifacts.

- **Time:** about 15 minutes. The run itself usually takes a few minutes.
- **You need:** a working task model from the [quick start](quick-start.md).
- **Input:** [`plant-growth.csv`](../../examples/plant-growth.csv), a synthetic sample shipped with the repository: 45 plants in three fertilizer treatments, with the daily light each plant received and its dry mass.
- **Skills and connectors:** none. The run uses the managed Python environment, which includes pandas, SciPy and Matplotlib.
- **You end with:** `growth-report.md` and `treatment-boxplot.png` in the Artifacts list.

This is the second lesson of the learning path. The [quick start](quick-start.md) is the first.

## 1. Get the sample file

If you cloned the repository, the file is already at `docs/examples/plant-growth.csv`. If you run the prepackaged binary, download it:

```bash
curl -LO https://raw.githubusercontent.com/openJiuwen-ai/sciencediscovery/main/docs/examples/plant-growth.csv
```

The values are synthetic and were generated for these tutorials; see [the sample data notes](../../examples/README.md).

## 2. Check the Python environment

Open **System configuration → Local Runner → Scientific environments**. The Python base environment should show **Ready**. A new data directory prepares it in the background after the first start; while it shows **Installing**, wait before you send the task.

## 3. Upload the file

Create a Project, for example `plant-growth`, and open its Session. In the **Workspace** panel on the right, drop `plant-growth.csv` onto **Drop files**, or click that area to choose the file. A confirmation appears, and the file is listed under **Files** and among the **Artifacts** as a user upload.

## 4. Send the task

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

## 5. Approve the first code execution

With the default approval mode, **Ask for dangerous actions**, the first command pauses on a **Permission required** card for **Run local code**. The card shows the command the Agent wants to run.

- **Allow once** approves this command only; the next command asks again.
- **Allow same type** approves this and later code executions, so the rest of the analysis runs without stopping.
- **Deny** refuses it, and the Agent has to continue without running code.

Choose **Allow same type** for this lesson. The code still runs inside the sandbox, with only the workspace and no network. You can revoke the grant later under **System configuration → Permissions**; the [last lesson](trace-a-result.md) does that.

## 6. What you should see

Different models write different code and prose, so expect the shape below rather than particular wording or numbers:

- The timeline shows the Agent listing and reading the file, then several code executions. Expand one to see the command and its output. A failed execution followed by a corrected one is normal.
- `growth-report.md` and `treatment-boxplot.png` appear among the **Artifacts**, often with the analysis script and a results file beside them.
- Opening `growth-report.md` shows a table with 15 plants per treatment, the ANOVA statistic and p-value, pairwise comparisons between the three treatments, the figure or a reference to it, and a limitations paragraph.
- The report says whether `light_hours` is balanced across treatments. In this sample it is not perfectly balanced, so a careful report discusses it instead of ignoring it.
- About a minute after the report is registered, the Reviewer may add an automatic review card. Its findings are the starting point of the [last lesson](trace-a-result.md).

## 7. Check your result

- [ ] The run finished and no longer appears as running.
- [ ] The timeline contains code executions that you approved.
- [ ] `growth-report.md` and `treatment-boxplot.png` are listed among the Artifacts.
- [ ] The numbers in the report come from executed code, and the figure opens in the preview.

If the run cannot import pandas, check that the Python environment is **Ready** and ask the Agent to use the managed environment. If no Artifact appears, ask it to declare the two files as artifacts.

## Next

Keep this Session; later lessons come back to its report. Continue with [Search the literature and write a cited summary](literature-search-and-report.md).
