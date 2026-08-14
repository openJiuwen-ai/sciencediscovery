---
name: code-engineer
description: Use this skill when you need to write and execute Python/R code to process, transform, and analyze data, delivering reproducible computational results with complete code-level methodology documentation. Supports statistical analysis, data transformation, visualization, method justification, and structured result output.
---

# Code Engineer Skill

## Overview

This skill writes and executes Python/R code to process, transform, and analyze data, delivering reproducible computational results with complete code-level methodology documentation. It focuses on code-level fidelity, computational result completeness, and methodology transparency.

## Core Capabilities

- Write and execute Python/R code for data processing, transformation, and statistical analysis
- Inspect data file structure (sheets, columns, types, row counts) before analysis
- Generate reproducible computational results with method justification
- Document code-level methodology (libraries, data transformations, key function calls)
- Adjust analysis per feedback and document changes
- Specify data traceability (file name, sheet name, field/column name, row count)
- Support both Python and R execution environments
- Export execution output to CSV, JSON, or Markdown (supports both raw text and structured DataFrame export)

## When to Use This Skill

**Always load this skill when:**

- User asks for data processing, transformation, or statistical analysis that must be executed as Python or R code 
- User wants reproducible computational results with documented libraries, methods, and assumptions
- User provides a data file (Excel/CSV/Parquet/etc.) and asks to inspect its schema, run analyses on it, or export structured results
- User asks for code-level methodology documentation alongside results (method justification, data traceability, key function calls, limitations)
- User wants a multi-step analysis pipeline with re-runnable code (Python or R scripts) rather than ad-hoc one-off answers


## Python Package Installation

If you need to install new Python packages, install them through the Tsinghua PyPI mirror for reliability:

```bash
pip install [python package] -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## Workflow

### Step 1: Understand Requirements

Identify what the analysis task requires:

- **Analysis objectives**: What computational results are expected
- **Available data**: File paths, data descriptions, format details

### Step 2: Inspect Available Data

Before writing analysis code, inspect the data to understand its schema and characteristics:

```bash
python ./scripts/execute.py \
  --action inspect \
  --files /path/to/data.xlsx
```

This returns:
- Sheet names (for Excel) or filename (for CSV)
- Column names, data types, and non-null counts
- Row count per sheet/file
- Sample data (first 5 rows)

### Step 3: Write and Execute Analysis Code

Based on the analysis objectives and data schema, write Python/R code to perform the analysis.

#### Execute Python Code

```bash
python ./scripts/execute.py \
  --action run \
  --language python \
  --code-file /path/to/workspace/analysis_step1.py \
  --files /path/to/data.xlsx \
  --output-file /path/to/outputs/analysis_results.json
```

#### Execute R Code

```bash
python ./scripts/execute.py \
  --action run \
  --language r \
  --code-file /path/to/workspace/analysis_step1.R \
  --files /path/to/data.xlsx \
  --output-file /path/to/outputs/analysis_results.json
```

#### Run Inline Code Snippet

```bash
python ./scripts/execute.py \
  --action run \
  --language python \
  --code "import pandas as pd; df = pd.read_excel('/path/to/data.xlsx'); print(df.describe())" \
  --output-file /path/to/outputs/summary_stats.csv
```

### Step 4: Document and Return Results

Structure your output per the Output Schema below. Ensure every result includes method justification, data traceability, assumptions, and code-level documentation.

When results may be evaluated downstream (e.g., by the `result-evaluator` skill), present a **Result Package** that includes both structured data AND methodology documentation. The `--output-file` exports only tabular data; the agent must also provide the following in conversation:

- **Methodology**: libraries used, statistical methods, key function calls, and justification for method choices
- **Data traceability**: source file names, sheet/column names, row counts, and any filtering or transformation applied
- **Assumptions & limitations**: distributional assumptions, sample size considerations, known data quality issues
- **Analysis code**: the complete code that produced the results (for reproducibility verification)

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--action` | Yes | One of: `inspect`, `run` |
| `--language` | For `run` | `python` or `r` |
| `--code` | For `run` | Inline code string to execute |
| `--code-file` | For `run` | Path to a Python/R script file to execute |
| `--files` | No | Space-separated paths to data files (loaded into execution context) |
| `--output-file` | No | Path to export results (CSV/JSON/MD). If the code assigns a DataFrame to `result`, it is exported as structured tabular data; otherwise raw stdout/stderr is exported |

> [!NOTE]
> Do NOT read the Python file, just call it with the parameters.

## Variable Naming Rules

When using `--files`, each data file is automatically loaded into the execution context as a variable:

- **Excel files**: The variable name is derived from the filename without extension (e.g., `sales_2024.xlsx` → `sales_2024`), loaded via `pd.read_excel()` in Python or `read_excel()` in R
- **CSV files**: The variable name is derived from the filename without extension (e.g., `data.csv` → `data`), loaded via `pd.read_csv()` in Python or `read.csv()` in R
- **Special characters**: Filenames with spaces or special characters are auto-sanitized (spaces → underscores). Names starting with digits are prefixed with `t_` (e.g., `2024_data.csv` → `t_2024_data`)
- **Multiple files**: Each file creates a separate variable, enabling cross-file analysis

## Complete Example

Task: "Analyze the correlation between variable X and Y in dataset.csv, and test whether the correlation is statistically significant."

### Step 1: Inspect the data file

```bash
python ./scripts/execute.py \
  --action inspect \
  --files /path/to/dataset.csv
```

### Step 2: Write analysis code and execute

```bash
python ./scripts/execute.py \
  --action run \
  --language python \
  --code-file /path/to/workspace/correlation_analysis.py \
  --files /path/to/dataset.csv \
  --output-file /path/to/outputs/correlation_results.json
```

Where `correlation_analysis.py` contains:

```python
import pandas as pd
from scipy import stats

data = pd.read_csv('/path/to/dataset.csv')
corr, p_value = stats.pearsonr(data['X'], data['Y'])

print(f"Pearson correlation: r={corr:.4f}, p={p_value:.6f}")
print(f"Sample size: n={len(data)}")
print(f"X stats: mean={data['X'].mean():.2f}, std={data['X'].std():.2f}")
print(f"Y stats: mean={data['Y'].mean():.2f}, std={data['Y'].std():.2f}")
```

### Step 3: Document results per Output Schema

Return structured results with method justification, assumptions, limitations, and code documentation.

## Output Handling

After code execution:

- Present key findings directly in conversation — highlight the most important results, not just raw output
- For large or multi-step results, export to file and share via `present_files` tool
- Always explain computational findings in plain language with actionable takeaways
- When code produces tables or statistics, format them clearly for readability
- Suggest follow-up analyses or refinements when patterns are interesting or inconclusive
- Offer to export results if the user wants to keep them
- If execution fails, explain the error context (e.g., missing library, data schema mismatch) and suggest a corrected approach

## Structured Export

When using `--output-file`, the script attempts to detect structured results automatically:

- If your code assigns a pandas DataFrame (or a list of dicts) to a variable named `result`, the script captures it as structured tabular data and exports columns + rows properly
- For CSV export: proper CSV with headers and rows
- For JSON export: array of records `[{col: val, ...}]`
- For MD export: Markdown table with `|` formatting
- If no `result` variable is found, the export falls back to raw stdout/stderr text

**Tip**: To get structured output, simply assign your final DataFrame to `result`:

```python
result = df.groupby('category').agg({'amount': 'sum'}).reset_index()
```

## Caching (inspect only)

Caching applies **only to `--action inspect`**. The script stores loaded DuckDB tables to avoid re-parsing files on every inspect call:

- On first inspect, files are loaded into a persistent DuckDB database under `<tempdir>/.code-engineer-cache/`
- The cache key is a SHA256 hash of all input file contents — if files change, a new cache is created
- Subsequent inspect calls with the same files reuse the cached database
- Cache is transparent — no extra parameters needed

Note: `--action run` does **not** use this cache. The Python (`pandas`) and R (`readxl`/`read.csv`) subprocesses re-read the data files on every invocation. If you want run-time caching for an analysis pipeline, cache results yourself and reuse them.

## Quality Assurance （optional but highly recommended）

For analyses where result quality matters, use the `result-evaluator` skill to evaluate output reliability and methodological rigor. This is especially recommended when:

- Results inform decisions or will be presented to stakeholders
- Statistical analyses where methodology correctness is critical
- Complex multi-step analyses where errors can compound

To evaluate: load `/mnt/skills/custom/result-evaluator/SKILL.md` and provide the full Result Package (structured data + methodology documentation + data traceability + analysis code) as evaluation input.

## Notes

- Python execution uses the system Python environment with auto-installation of missing packages
- R execution requires R to be installed on the system (auto-detected via `Rscript` or `R`)
- For large datasets, DuckDB handles them efficiently without loading everything into memory
- Column names with spaces are accessible using double quotes in SQL: `"Column Name"`
