# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Code Engineer Execution Script.

Executes Python/R code for data processing, transformation, and statistical analysis.
Supports schema inspection, inline/file-based code execution, and result export.
"""

import argparse
import csv
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import tempfile

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

try:
    import duckdb
except ImportError:
    logger.error("duckdb is not installed. Installing...")
    subprocess.run([sys.executable, "-m", "pip", "install", "duckdb", "openpyxl", "-q"], check=True)
    import duckdb

try:
    import openpyxl  # noqa: F401
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "openpyxl", "-q"], check=True)

CACHE_DIR = os.path.join(tempfile.gettempdir(), ".code-engineer-cache")
TABLE_MAP_SUFFIX = ".table_map.json"


def compute_files_hash(files: list[str]) -> str:
    """Compute a combined SHA256 hash of all input files for cache key."""
    hasher = hashlib.sha256()
    for file_path in sorted(files):
        try:
            with open(file_path, "rb") as f:
                while chunk := f.read(8192):
                    hasher.update(chunk)
        except OSError:
            hasher.update(file_path.encode())
    return hasher.hexdigest()


def get_cache_db_path(files_hash: str) -> str:
    """Get the path to the cached DuckDB database file."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"{files_hash}.duckdb")


def get_table_map_path(files_hash: str) -> str:
    """Get the path to the cached table map JSON file."""
    return os.path.join(CACHE_DIR, f"{files_hash}{TABLE_MAP_SUFFIX}")


def save_table_map(files_hash: str, table_map: dict[str, str]) -> None:
    """Save table map to a JSON file alongside the cached DB."""
    path = get_table_map_path(files_hash)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(table_map, f, ensure_ascii=False)


def load_table_map(files_hash: str) -> dict[str, str] | None:
    """Load table map from cache. Returns None if not found."""
    path = get_table_map_path(files_hash)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def sanitize_table_name(name: str) -> str:
    """Sanitize a sheet/file name into a valid SQL table name."""
    sanitized = re.sub(r"[^\w]", "_", name)
    if sanitized and sanitized[0].isdigit():
        sanitized = f"t_{sanitized}"
    return sanitized


def _sql_escape(s: str) -> str:
    """Escape a string for use inside an SQL single-quoted literal.

    Doubles any single quote (SQL standard). Used before splicing file paths
    and sheet names into ``CREATE TABLE ... st_read(...)`` and
    ``read_csv_auto(...)`` statements, where unescaped ``'`` (common in sheet
    names) would otherwise break the query.
    """
    return s.replace("'", "''")


def _py_escape(s: str) -> str:
    """Quote a Python string literal embedding ``s`` into Python source code.

    Uses ``json.dumps`` which produces a valid Python double-quoted string
    literal — the result can be injected directly into generated Python code
    without further escaping, even when ``s`` contains single quotes or
    backslashes.
    """
    return json.dumps(s)


def _r_escape(s: str) -> str:
    """Quote an R string literal embedding ``s`` into R source code.

    R single-quoted strings escape single quotes with backslash. ``\\\\`` is
    doubled so that ``\\`` in ``s`` doesn't become a stray escape after the
    quote-escape round.
    """
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def load_files(con: duckdb.DuckDBPyConnection, files: list[str]) -> dict[str, str]:
    """Load Excel/CSV files into DuckDB tables. Returns a mapping of original_name -> sanitized_table_name."""
    con.execute("INSTALL spatial; LOAD spatial;")
    table_map: dict[str, str] = {}

    for file_path in files:
        if not os.path.exists(file_path):
            logger.error(f"File not found: {file_path}")
            continue

        ext = os.path.splitext(file_path)[1].lower()

        if ext in (".xlsx", ".xls"):
            _load_excel(con, file_path, table_map)
        elif ext == ".csv":
            _load_csv(con, file_path, table_map)
        else:
            logger.warning(f"Unsupported file format: {ext} ({file_path})")

    return table_map


def _load_excel(
    con: duckdb.DuckDBPyConnection, file_path: str, table_map: dict[str, str]
) -> None:
    """Load all sheets from an Excel file into DuckDB tables.

    Each sheet is registered under a composite key ``f"{abs_path}::{sheet}"``
    in ``table_map`` so that two different files with the same sheet name
    don't collide (previously the second file's entry would silently
    overwrite the first, leaving the first sheet's DuckDB table orphaned).
    """
    import openpyxl

    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    sheet_names = wb.sheetnames
    wb.close()

    file_basename_safe = sanitize_table_name(os.path.splitext(os.path.basename(file_path))[0])
    abs_path = os.path.abspath(file_path)
    fp_sql = _sql_escape(file_path)

    for sheet_name in sheet_names:
        base_table = sanitize_table_name(sheet_name)
        table_name = f"{file_basename_safe}_{base_table}"

        original_table_name = table_name
        counter = 1
        while table_name in table_map.values():
            table_name = f"{original_table_name}_{counter}"
            counter += 1

        composite_key = f"{abs_path}::{sheet_name}"

        try:
            sn_sql = _sql_escape(sheet_name)
            con.execute(
                f"""
                CREATE TABLE "{table_name}" AS
                SELECT * FROM st_read(
                    '{fp_sql}',
                    layer = '{sn_sql}',
                    open_options = ['HEADERS=FORCE', 'FIELD_TYPES=AUTO']
                )
            """
            )
            table_map[composite_key] = table_name
            row_count = con.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
            logger.info(
                f"  Loaded sheet '{sheet_name}' from '{file_path}' -> table '{table_name}' ({row_count} rows)"
            )
        except Exception as e:
            logger.warning(f"  Failed to load sheet '{sheet_name}' from '{file_path}': {e}")


def _load_csv(
    con: duckdb.DuckDBPyConnection, file_path: str, table_map: dict[str, str]
) -> None:
    """Load a CSV file into a DuckDB table.

    Registered under the absolute file path as its key so two CSVs in
    different directories that share a basename (e.g. ``./a/data.csv`` and
    ``./b/data.csv``) do not collide on the same dict key — the old version
    used ``base_name`` and silently overwrote the first file's entry.
    """
    base_name = os.path.splitext(os.path.basename(file_path))[0]
    file_basename_safe = sanitize_table_name(base_name)
    table_name = file_basename_safe

    original_table_name = table_name
    counter = 1
    while table_name in table_map.values():
        table_name = f"{original_table_name}_{counter}"
        counter += 1

    composite_key = os.path.abspath(file_path)

    try:
        fp_sql = _sql_escape(file_path)
        con.execute(
            f"""
            CREATE TABLE "{table_name}" AS
            SELECT * FROM read_csv_auto('{fp_sql}')
        """
        )
        table_map[composite_key] = table_name
        row_count = con.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        logger.info(
            f"  Loaded CSV '{base_name}' from '{file_path}' -> table '{table_name}' ({row_count} rows)"
        )
    except Exception as e:
        logger.warning(f"  Failed to load CSV '{base_name}' from '{file_path}': {e}")


def action_inspect(
    con: duckdb.DuckDBPyConnection,
    table_map: dict[str, str],
    output_file: str | None = None,
) -> str:
    """Inspect the schema of all loaded tables.

    When ``output_file`` is provided, the displayed text is also written to
    that path. For ``.json`` outputs, a structured dump is produced instead
    (per-table columns / types / non-null counts / sample rows).
    """
    output_parts = []

    for original_name, table_name in table_map.items():
        output_parts.append(f"\n{'=' * 60}")
        output_parts.append(f'Table: {original_name} (SQL name: "{table_name}")')
        output_parts.append(f"{'=' * 60}")

        row_count = con.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        output_parts.append(f"Rows: {row_count}")

        columns = con.execute(f'DESCRIBE "{table_name}"').fetchall()
        output_parts.append(f"\nColumns ({len(columns)}):")
        output_parts.append(f"{'Name':<30} {'Type':<15} {'Nullable'}")
        output_parts.append(f"{'-' * 30} {'-' * 15} {'-' * 8}")
        for col in columns:
            col_name, col_type, nullable = col[0], col[1], col[2]
            output_parts.append(f"{col_name:<30} {col_type:<15} {nullable}")

        col_names = [col[0] for col in columns]
        non_null_parts = []
        for c in col_names:
            non_null_parts.append(f'COUNT("{c}") as "{c}"')
        non_null_sql = f'SELECT {", ".join(non_null_parts)} FROM "{table_name}"'
        try:
            non_null_counts = con.execute(non_null_sql).fetchone()
            output_parts.append("\nNon-null counts:")
            for i, c in enumerate(col_names):
                output_parts.append(f"  {c}: {non_null_counts[i]} / {row_count}")
        except Exception:
            pass

        output_parts.append("\nSample data (first 5 rows):")
        try:
            sample = con.execute(f'SELECT * FROM "{table_name}" LIMIT 5').fetchdf()
            output_parts.append(sample.to_string(index=False))
        except Exception:
            sample = con.execute(f'SELECT * FROM "{table_name}" LIMIT 5').fetchall()
            header = [col[0] for col in columns]
            output_parts.append("  " + " | ".join(header))
            for row in sample:
                output_parts.append("  " + " | ".join(str(v) for v in row))

    result = "\n".join(output_parts)
    print(result)

    if output_file:
        _export_inspect_output(con, table_map, result, output_file)

    return result


def _export_inspect_output(
    con: duckdb.DuckDBPyConnection,
    table_map: dict[str, str],
    text_output: str,
    output_file: str,
) -> None:
    """Write inspect result to ``output_file``.

    JSON produces a structured payload (per-table: column types, non-null
    counts, sample rows); other extensions receive the raw text dump written
    by ``action_inspect``.
    """
    output_dir = os.path.dirname(output_file)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    ext = os.path.splitext(output_file)[1].lower()

    if ext == ".json":
        schema: dict = {}
        for original_name, table_name in table_map.items():
            entry: dict = {"sql_table_name": table_name}
            try:
                row_count = con.execute(
                    f'SELECT COUNT(*) FROM "{table_name}"'
                ).fetchone()[0]
                columns = con.execute(f'DESCRIBE "{table_name}"').fetchall()
                col_info = [
                    {"name": c[0], "type": c[1], "nullable": c[2]} for c in columns
                ]

                col_names = [c[0] for c in columns]
                non_null_parts = [
                    f'COUNT("{c}") as "{c}"' for c in col_names
                ]
                non_null_counts: dict = {}
                if non_null_parts:
                    try:
                        counts_row = con.execute(
                            f'SELECT {", ".join(non_null_parts)} FROM "{table_name}"'
                        ).fetchone()
                        non_null_counts = {
                            c: counts_row[i]
                            for i, c in enumerate(col_names)
                            if counts_row is not None
                        }
                    except Exception:
                        non_null_counts = {}

                sample_rows: list = []
                try:
                    sample_df = con.execute(
                        f'SELECT * FROM "{table_name}" LIMIT 5'
                    ).fetchdf()
                    sample_rows = sample_df.to_dict(orient="records")
                except Exception:
                    sample_tuples = con.execute(
                        f'SELECT * FROM "{table_name}" LIMIT 5'
                    ).fetchall()
                    sample_rows = [
                        dict(zip(col_names, row)) for row in sample_tuples
                    ]

                entry["row_count"] = row_count
                entry["columns"] = col_info
                entry["non_null_counts"] = non_null_counts
                entry["sample_rows"] = sample_rows
            except Exception as e:
                entry["error"] = str(e)
            schema[original_name] = entry

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(schema, f, indent=2, ensure_ascii=False, default=str)
        logger.info(f"Inspect schema exported to {output_file}")
        return

    if ext == ".md":
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(f"```\n{text_output}\n```\n")
    else:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(text_output)
    logger.info(f"Inspect output exported to {output_file}")


_RESULT_MARKER = "__code_engineer_result__"
_RESULT_FILE = "__result__.json"


def _build_result_capture_snippet(result_var: str, output_file_path: str | None) -> str:
    """Build Python snippet that captures a DataFrame-like result into a JSON file."""
    if not output_file_path:
        return ""
    return f"""
import json as _json
try:
    _result_obj = {result_var}
    if hasattr(_result_obj, 'to_dict'):
        _records = _result_obj.to_dict(orient='records')
        _columns = list(_result_obj.columns)
    elif isinstance(_result_obj, (list, tuple)) and len(_result_obj) > 0 and isinstance(_result_obj[0], dict):
        _columns = list(_result_obj[0].keys())
        _records = _result_obj
    else:
        _records = None
        _columns = None
    if _records is not None:
        with open('{_RESULT_FILE}', 'w', encoding='utf-8') as _f:
            _json.dump({'columns': _columns, 'rows': _records}, _f, ensure_ascii=False, default=str)
        print('{_RESULT_MARKER}structured')
except Exception:
    pass
"""


def action_run_python(
    code: str,
    data_files: list[str] | None = None,
    output_file: str | None = None,
) -> str:
    """Execute Python code in a subprocess with auto data-file loading and optional structured export."""
    result_dir = tempfile.mkdtemp(prefix="code-engineer-result-")
    result_file_path = os.path.join(result_dir, _RESULT_FILE)

    setup_lines = []
    if data_files:
        try:
            import pandas as pd
        except ImportError:
            subprocess.run([sys.executable, "-m", "pip", "install", "pandas", "-q"], check=True)
            import pandas as pd

        for fp in data_files:
            var_name = sanitize_table_name(os.path.splitext(os.path.basename(fp))[0])
            ext = os.path.splitext(fp)[1].lower()
            fp_py = _py_escape(fp)
            if ext in (".xlsx", ".xls"):
                setup_lines.append(f"{var_name} = pd.read_excel({fp_py})")
            elif ext == ".csv":
                setup_lines.append(f"{var_name} = pd.read_csv({fp_py})")
            else:
                setup_lines.append(f"# Unsupported file format: {ext} ({_py_escape(fp)})")

    capture_snippet = _build_result_capture_snippet("result", output_file)

    full_code = "\n".join(setup_lines) + "\n\n" + code + "\n\n" + capture_snippet

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tmp:
        tmp.write(full_code)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            [sys.executable, tmp_path],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=result_dir,
        )

        structured = False
        if result.returncode == 0 and os.path.exists(result_file_path):
            try:
                with open(result_file_path, "r", encoding="utf-8") as f:
                    structured_data = json.load(f)
                columns = structured_data.get("columns", [])
                rows = structured_data.get("rows", [])
                structured = True
            except Exception:
                structured = False

        if structured and output_file:
            _cleanup_result_dir(result_dir, tmp_path)
            return _export_structured_results(columns, rows, output_file)

        if structured and not output_file:
            formatted = _format_table(columns, rows)
            stdout = result.stdout.replace(f"{_RESULT_MARKER}structured", "").strip()
            if stdout:
                combined = stdout + "\n\n" + formatted
            else:
                combined = formatted
            _cleanup_result_dir(result_dir, tmp_path)
            print(combined)
            return combined

        output_parts = []
        if result.stdout:
            output_parts.append(result.stdout)
        if result.stderr:
            output_parts.append(f"\nSTDERR:\n{result.stderr}")
        if result.returncode != 0:
            available_hint = _build_error_hint(data_files)
            if available_hint:
                output_parts.append(available_hint)
            output_parts.append(f"\nExit code: {result.returncode}")

        combined = "\n".join(output_parts) if output_parts else "(no output)"

        if output_file:
            _cleanup_result_dir(result_dir, tmp_path)
            return _export_output(combined, result.returncode, output_file)

        _cleanup_result_dir(result_dir, tmp_path)
        print(combined)
        return combined
    except subprocess.TimeoutExpired:
        _cleanup_result_dir(result_dir, tmp_path)
        msg = "Execution timed out (300s limit)"
        print(msg)
        return msg
    except Exception as e:
        _cleanup_result_dir(result_dir, tmp_path)
        msg = f"Execution error: {e}"
        print(msg)
        return msg


def action_run_r(
    code: str,
    data_files: list[str] | None = None,
    output_file: str | None = None,
) -> str:
    """Execute R code in a subprocess with auto data-file loading and optional structured export."""
    r_path = _find_r_executable()
    if not r_path:
        msg = "R is not installed or not found on the system"
        print(msg)
        return msg

    result_dir = tempfile.mkdtemp(prefix="code-engineer-result-")
    result_file_path = os.path.join(result_dir, _RESULT_FILE)

    setup_lines = []
    if data_files:
        for fp in data_files:
            var_name = sanitize_table_name(os.path.splitext(os.path.basename(fp))[0])
            ext = os.path.splitext(fp)[1].lower()
            fp_r = _r_escape(fp)
            if ext in (".xlsx", ".xls"):
                setup_lines.append(f"library(readxl)")
                setup_lines.append(f"{var_name} <- read_excel({fp_r})")
            elif ext == ".csv":
                setup_lines.append(f"{var_name} <- read.csv({fp_r})")
            else:
                setup_lines.append(f"# Unsupported file format: {ext} ({_r_escape(fp)})")

    r_capture = ""
    if output_file:
        # Constants _RESULT_FILE / _RESULT_MARKER are ASCII-only, so no escaping needed.
        r_capture = (
            "tryCatch({\n"
            "    if (exists('result') && is.data.frame(result)) {\n"
            "        cols <- colnames(result)\n"
            "        rows_json <- jsonlite::toJSON(result)\n"
            f"        writeLines(paste0('{{\"columns\": ', jsonlite::toJSON(cols), ', \"rows\": ', rows_json, '}}'), '{_RESULT_FILE}')\n"
            f"        cat('{_RESULT_MARKER}structured')\n"
            "    }\n"
            "}, error = function(e) {})\n"
        )

    full_code = "\n".join(setup_lines) + "\n\n" + code + "\n\n" + r_capture

    with tempfile.NamedTemporaryFile(mode="w", suffix=".R", delete=False, encoding="utf-8") as tmp:
        tmp.write(full_code)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            [r_path, tmp_path],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=result_dir,
        )

        structured = False
        if result.returncode == 0 and os.path.exists(result_file_path):
            try:
                with open(result_file_path, "r", encoding="utf-8") as f:
                    structured_data = json.load(f)
                columns = structured_data.get("columns", [])
                rows = structured_data.get("rows", [])
                structured = True
            except Exception:
                structured = False

        if structured and output_file:
            _cleanup_result_dir(result_dir, tmp_path)
            return _export_structured_results(columns, rows, output_file)

        if structured and not output_file:
            formatted = _format_table(columns, rows)
            stdout = result.stdout.replace(f"{_RESULT_MARKER}structured", "").strip()
            if stdout:
                combined = stdout + "\n\n" + formatted
            else:
                combined = formatted
            _cleanup_result_dir(result_dir, tmp_path)
            print(combined)
            return combined

        output_parts = []
        if result.stdout:
            output_parts.append(result.stdout)
        if result.stderr:
            output_parts.append(f"\nSTDERR:\n{result.stderr}")
        if result.returncode != 0:
            available_hint = _build_error_hint(data_files)
            if available_hint:
                output_parts.append(available_hint)
            output_parts.append(f"\nExit code: {result.returncode}")

        combined = "\n".join(output_parts) if output_parts else "(no output)"

        if output_file:
            _cleanup_result_dir(result_dir, tmp_path)
            return _export_output(combined, result.returncode, output_file)

        _cleanup_result_dir(result_dir, tmp_path)
        print(combined)
        return combined
    except subprocess.TimeoutExpired:
        _cleanup_result_dir(result_dir, tmp_path)
        msg = "Execution timed out (300s limit)"
        print(msg)
        return msg
    except Exception as e:
        _cleanup_result_dir(result_dir, tmp_path)
        msg = f"Execution error: {e}"
        print(msg)
        return msg


def _find_r_executable() -> str | None:
    """Detect R installation by trying Rscript and R with --version."""
    for candidate in ["Rscript", "R"]:
        try:
            result = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return candidate
        except Exception:
            continue
    return None


def _cleanup_result_dir(result_dir: str, script_path: str) -> None:
    """Remove temporary result directory and script file."""
    try:
        if os.path.exists(script_path):
            os.unlink(script_path)
        if os.path.exists(result_dir):
            for f in os.listdir(result_dir):
                os.unlink(os.path.join(result_dir, f))
            os.rmdir(result_dir)
    except Exception:
        pass


def _build_error_hint(data_files: list[str] | None) -> str:
    """Build a hint string listing available data file variables for error context."""
    if not data_files:
        return ""
    hint_parts = ["\nAvailable data variables:"]
    for fp in data_files:
        var_name = sanitize_table_name(os.path.splitext(os.path.basename(fp))[0])
        ext = os.path.splitext(fp)[1].lower()
        if ext in (".xlsx", ".xls", ".csv"):
            hint_parts.append(f"  {var_name} (from {os.path.basename(fp)})")
    return "\n".join(hint_parts)


def _format_table(columns: list[str], rows: list) -> str:
    """Format structured results as a readable text table with column widths and row count."""
    if not rows:
        msg = "Result returned 0 rows."
        print(msg)
        return msg

    col_widths = [len(str(c)) for c in columns]
    for row in rows:
        for i, val in enumerate(row):
            if i < len(col_widths):
                col_widths[i] = max(col_widths[i], len(str(val)))

    max_width = 40
    col_widths = [min(w, max_width) for w in col_widths]

    parts = []
    header = " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(columns))
    separator = "-+-".join("-" * col_widths[i] for i in range(len(columns)))
    parts.append(header)
    parts.append(separator)
    for row in rows:
        row_str = " | ".join(
            str(v)[:max_width].ljust(col_widths[i]) for i, v in enumerate(row)
        )
        parts.append(row_str)

    parts.append(f"\n({len(rows)} rows)")
    result = "\n".join(parts)
    print(result)
    return result


def _export_structured_results(columns: list[str], rows: list, output_file: str) -> str:
    """Export structured tabular results to file (CSV, JSON, or Markdown).

    Each row may be either a list/tuple (positional) or a dict (column-name
    keyed). The previous version assumed positional rows, so a list-of-dicts
    result — produced when ``result`` is a Python ``list`` of dicts or comes
    from R via jsonlite — would raise ``KeyError`` because dicts cannot be
    indexed by integer position.
    """
    os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)
    ext = os.path.splitext(output_file)[1].lower()

    def _row_to_cells(row):
        """Project a row onto ``columns``, returning a list aligned with columns."""
        if isinstance(row, dict):
            return [row.get(col) for col in columns]
        return [row[i] if i < len(row) else None for i in range(len(columns))]

    def _normalize(val):
        """Convert non-JSON-native types (datetime, bytes) into JSON-safe forms."""
        if val is None:
            return None
        if hasattr(val, "isoformat"):
            try:
                return val.isoformat()
            except TypeError:
                return str(val)
        if isinstance(val, (bytes, bytearray)):
            return val.hex()
        return val

    if ext == ".csv":
        with open(output_file, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(columns)
            for row in rows:
                writer.writerow(_row_to_cells(row))

    elif ext == ".json":
        records = []
        for row in rows:
            cells = _row_to_cells(row)
            record = {col: _normalize(cells[i]) for i, col in enumerate(columns)}
            records.append(record)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2, ensure_ascii=False, default=str)

    elif ext == ".md":
        with open(output_file, "w", encoding="utf-8") as f:
            f.write("| " + " | ".join(columns) + " |\n")
            f.write("| " + " | ".join("---" for _ in columns) + " |\n")
            for row in rows:
                cells = _row_to_cells(row)
                cell_strs = [
                    "" if v is None else str(v).replace("|", "\\|") for v in cells
                ]
                f.write("| " + " | ".join(cell_strs) + " |\n")
    else:
        msg = f"Unsupported output format: {ext}. Use .csv, .json, or .md"
        print(msg)
        return msg

    msg = f"Results exported to {output_file} ({len(rows)} rows)"
    print(msg)
    return msg


def _export_output(content: str, exit_code: int, output_file: str) -> str:
    """Export raw execution output (stdout/stderr) to file, used as fallback when no structured result is available."""
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    ext = os.path.splitext(output_file)[1].lower()

    if ext == ".json":
        record = {
            "stdout_stderr": content,
            "exit_code": exit_code,
        }
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
    elif ext == ".csv":
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(content)
    elif ext == ".md":
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(f"## Execution Output\n\n```\n{content}\n```\n\n**Exit code**: {exit_code}\n")
    else:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(content)

    msg = f"Output exported to {output_file}"
    print(msg)
    return msg


def main():
    """Parse arguments and dispatch to the appropriate action."""
    # Compatibility shim: earlier versions of SKILL.md documented --data-files
    # as the data-file flag. Accept it as an alias for --files so agents and
    # tools written against the older docs continue to work. Removal of this
    # shim should wait until SKILL.md is migrated.
    if "--data-files" in sys.argv:
        sys.argv = [a if a != "--data-files" else "--files" for a in sys.argv]

    parser = argparse.ArgumentParser(description="Execute Python/R code for data analysis")
    parser.add_argument(
        "--action",
        required=True,
        choices=["inspect", "run"],
        help="Action to perform: inspect or run",
    )
    parser.add_argument(
        "--language",
        type=str,
        default="python",
        choices=["python", "r"],
        help="Programming language for execution (default: python)",
    )
    parser.add_argument(
        "--code",
        type=str,
        default=None,
        help="Inline code string to execute",
    )
    parser.add_argument(
        "--code-file",
        type=str,
        default=None,
        help="Path to a Python/R script file to execute",
    )
    parser.add_argument(
        "--files",
        nargs="+",
        default=None,
        help="Paths to data files (loaded into execution context)",
    )
    parser.add_argument(
        "--output-file",
        type=str,
        default=None,
        help="Path to export execution output (CSV/JSON/MD)",
    )
    args = parser.parse_args()

    if args.action == "run" and not args.code and not args.code_file:
        parser.error("--code or --code-file is required for 'run' action")

    if args.code_file and args.code:
        parser.error("Specify either --code or --code-file, not both")

    if args.action == "inspect":
        if not args.files:
            parser.error("--files is required for 'inspect' action")

        files_hash = compute_files_hash(args.files)
        db_path = get_cache_db_path(files_hash)
        cached_table_map = load_table_map(files_hash)

        if cached_table_map and os.path.exists(db_path):
            logger.info(f"Cache hit! Using cached database: {db_path}")
            con = duckdb.connect(db_path, read_only=True)
            table_map = cached_table_map
            logger.info(f"Loaded {len(table_map)} table(s) from cache: {', '.join(table_map.keys())}")
        else:
            logger.info("Loading files (first time, will cache for future use)...")
            con = duckdb.connect(db_path)
            table_map = load_files(con, args.files)

            if not table_map:
                logger.error("No tables were loaded. Check file paths and formats.")
                con.close()
                if os.path.exists(db_path):
                    os.remove(db_path)
                sys.exit(1)

            save_table_map(files_hash, table_map)
            logger.info(f"\nLoaded {len(table_map)} table(s): {', '.join(table_map.keys())}")
            logger.info(f"Cached database saved to: {db_path}")

        action_inspect(con, table_map, args.output_file)
        con.close()

    elif args.action == "run":
        code = args.code
        if args.code_file:
            if not os.path.exists(args.code_file):
                logger.error(f"Code file not found: {args.code_file}")
                sys.exit(1)
            with open(args.code_file, "r", encoding="utf-8") as f:
                code = f.read()

        if args.language == "python":
            action_run_python(code, args.files, args.output_file)
        elif args.language == "r":
            action_run_r(code, args.files, args.output_file)


if __name__ == "__main__":
    main()
