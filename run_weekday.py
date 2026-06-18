#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from shutil import which
from urllib.parse import urlparse

import gspread
from google.oauth2 import service_account


ROOT = Path(__file__).resolve().parent
ANALYZER = ROOT / "analyze.mjs"
OUTPUT_ROOT = ROOT / "output" / "weekday-runs"
DEFAULT_SHEET_ID = "1Z5DzAXj7GHmcveHTodIIhNXpjzuC4UfPRJc5exnHr6E"
DEFAULT_SOURCE_TAB = "BI TOp 50 By Month"
DEFAULT_OUTPUT_TAB = "Daily Re-Share Suggestions"
DEFAULT_CREDS = "/Users/mmitchell/Downloads/partnerships-peeler-17739c16da8e.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

HEADER = [
    "Re-Shared",
    "Suggesed Re Share Date",
    "Original Pub Date",
    "Article Title",
    "Author",
    "URL",
    "Category",
    "Previous Total Engaged Min",
]


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def get_env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def parse_run_date() -> str:
    override = os.environ.get("APPLE_NEWS_RUN_DATE", "").strip()
    if override:
        return override
    return datetime.now().date().isoformat()


def build_client(creds_path: str) -> gspread.Client:
    credentials = service_account.Credentials.from_service_account_file(creds_path, scopes=SCOPES)
    return gspread.authorize(credentials)


def worksheet_by_title(spreadsheet: gspread.Spreadsheet, title: str) -> gspread.Worksheet:
    try:
        return spreadsheet.worksheet(title)
    except gspread.WorksheetNotFound:
        for worksheet in spreadsheet.worksheets():
            if worksheet.title.strip().lower() == title.strip().lower():
                return worksheet
        worksheet = spreadsheet.add_worksheet(title=title, rows=1000, cols=len(HEADER))
        worksheet.update(values=[HEADER], range_name="A1", value_input_option="RAW")
        return worksheet


def ensure_checkbox_validation(spreadsheet: gspread.Spreadsheet, worksheet: gspread.Worksheet) -> None:
    if worksheet.row_count < 5000:
        worksheet.resize(rows=5000, cols=max(worksheet.col_count, len(HEADER)))
    spreadsheet.batch_update(
        {
            "requests": [
                {
                    "setDataValidation": {
                        "range": {
                            "sheetId": worksheet.id,
                            "startRowIndex": 1,
                            "startColumnIndex": 0,
                            "endRowIndex": worksheet.row_count,
                            "endColumnIndex": 1,
                        },
                        "rule": {
                            "condition": {"type": "BOOLEAN"},
                            "strict": True,
                            "showCustomUi": True,
                        },
                    }
                }
            ]
        }
    )


def format_minutes_column(spreadsheet: gspread.Spreadsheet, worksheet: gspread.Worksheet) -> None:
    spreadsheet.batch_update(
        {
            "requests": [
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": worksheet.id,
                            "startRowIndex": 1,
                            "endRowIndex": worksheet.row_count,
                            "startColumnIndex": 7,
                            "endColumnIndex": 8,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "horizontalAlignment": "CENTER",
                                "numberFormat": {
                                    "type": "NUMBER",
                                    "pattern": "#,##0",
                                },
                            }
                        },
                        "fields": "userEnteredFormat(horizontalAlignment,numberFormat)",
                    }
                }
            ]
        }
    )


def ensure_header(worksheet: gspread.Worksheet) -> None:
    row_1 = worksheet.row_values(1)
    if not row_1:
        worksheet.update(values=[HEADER], range_name="A1", value_input_option="RAW")
        return
    if row_1[: len(HEADER)] != HEADER:
        worksheet.batch_clear([f"A1:Z{worksheet.row_count}"])
        worksheet.update(values=[HEADER], range_name="A1", value_input_option="RAW")


def export_sheet_to_temp_csv(worksheet: gspread.Worksheet) -> tuple[str, int]:
    values = worksheet.get_all_values()
    if not values:
        raise RuntimeError(f"Worksheet {worksheet.title!r} is empty.")

    temp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv", prefix="apple-news-bi-")
    with open(temp.name, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(values)
    return temp.name, max(0, len(values) - 1)


def run_analyzer(csv_path: str, outdir: Path, as_of: str) -> None:
    node_bin = os.environ.get("APPLE_NEWS_NODE_BIN", "").strip()
    if not node_bin:
        node_bin = which("node") or ""
    if not node_bin:
        for candidate in ("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"):
            if os.path.exists(candidate):
                node_bin = candidate
                break
    if not node_bin:
        raise RuntimeError("Unable to locate a node binary. Set APPLE_NEWS_NODE_BIN or install node.")

    outdir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            node_bin,
            str(ANALYZER),
            "--input",
            csv_path,
            "--outdir",
            str(outdir),
            "--as-of",
            as_of,
        ],
        check=True,
    )


def load_shortlist(outdir: Path) -> list[dict]:
    summary_path = outdir / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    shortlist = summary.get("shortlist", [])
    if not isinstance(shortlist, list):
        raise RuntimeError(f"Unexpected shortlist format in {summary_path}")
    return shortlist


def load_ranked_candidates(outdir: Path) -> list[dict]:
    path = outdir / "unique-scored-stories.csv"
    with open(path, "r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)

    def score_key(row: dict) -> tuple[float, float]:
        try:
            score = float(row.get("score", 0) or 0)
        except ValueError:
            score = 0.0
        try:
            minutes = float(row.get("totalEngagedMinutes", 0) or 0)
        except ValueError:
            minutes = 0.0
        return score, minutes

    rows.sort(key=score_key, reverse=True)
    return rows


def normalize_url(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc:
        return parsed.path.strip("/")
    return raw.lstrip("/").split("?", 1)[0]


def checked_url_gate(worksheet: gspread.Worksheet) -> set[str]:
    checked = set()
    values = worksheet.get_all_values()
    for row in values[1:]:
        if not row:
            continue
        if row[0].strip().upper() != "TRUE":
            continue
        if len(row) > 5 and row[5].strip():
            checked.add(normalize_url(row[5]))
    return checked


def remove_existing_run_rows(worksheet: gspread.Worksheet, run_date: str) -> int:
    values = worksheet.get_all_values()
    if len(values) <= 1:
        return 0
    rows_to_delete = []
    for idx, row in enumerate(values[1:], start=2):
        if len(row) > 1 and row[1] == run_date:
            rows_to_delete.append(idx)
    for row_index in reversed(rows_to_delete):
        worksheet.delete_rows(row_index)
    return len(rows_to_delete)


def prepend_suggestions(
    worksheet: gspread.Worksheet,
    shortlist: list[dict],
    run_date: str,
) -> int:
    rows = []

    for rank, item in enumerate(shortlist[:10], start=1):
        rows.append(
            [
                "",
                run_date,
                item.get("datePublished", ""),
                item.get("article", ""),
                item.get("author", ""),
                f"https://www.businessinsider.com/{str(item.get('publisherArticleId', '')).split('?')[0]}",
                item.get("category", ""),
                int(float(item.get("totalEngagedMinutes", 0) or 0)),
            ]
        )

    if not rows:
        return 0

    removed = remove_existing_run_rows(worksheet, run_date)
    if removed:
        log(f"Removed {removed} existing rows for {run_date}.")

    blank_rows = [["" for _ in HEADER] for _ in rows]
    worksheet.insert_rows(blank_rows, row=2, value_input_option="RAW")
    worksheet.update(values=rows, range_name=f"A2:H{len(rows) + 1}", value_input_option="RAW")
    return len(rows)


def main() -> int:
    sheet_id = get_env("APPLE_NEWS_SHEET_ID", DEFAULT_SHEET_ID)
    source_tab = get_env("APPLE_NEWS_SOURCE_TAB", DEFAULT_SOURCE_TAB)
    output_tab = get_env("APPLE_NEWS_OUTPUT_TAB", DEFAULT_OUTPUT_TAB)
    creds_path = get_env("GOOGLE_APPLICATION_CREDENTIALS", DEFAULT_CREDS)
    if not os.path.exists(creds_path):
        alt_creds = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
        if alt_creds and os.path.exists(alt_creds):
            creds_path = alt_creds

    if not os.path.exists(creds_path):
        raise RuntimeError(
            "Missing Google service account JSON. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_FILE."
        )

    today = parse_run_date()
    run_dir = OUTPUT_ROOT / today

    log(f"Starting Apple News weekday run for {today}.")
    log(f"Using sheet {sheet_id} tab {source_tab!r}.")

    client = build_client(creds_path)
    spreadsheet = client.open_by_key(sheet_id)
    source_ws = worksheet_by_title(spreadsheet, source_tab)
    output_ws = worksheet_by_title(spreadsheet, output_tab)
    ensure_header(output_ws)
    ensure_checkbox_validation(spreadsheet, output_ws)
    format_minutes_column(spreadsheet, output_ws)
    checked_urls = checked_url_gate(output_ws)
    if checked_urls:
        log(f"Found {len(checked_urls)} checked URLs in {output_tab!r}; they will be excluded.")

    temp_csv, source_row_count = export_sheet_to_temp_csv(source_ws)
    log(f"Exported {source_row_count} source rows to temporary CSV.")

    try:
        run_analyzer(temp_csv, run_dir, today)
        candidates = load_ranked_candidates(run_dir)
        filtered_candidates = []
        for row in candidates:
            publisher_article_id = str(row.get("publisherArticleId", "")).split("?")[0].strip()
            if not publisher_article_id:
                continue
            url_key = normalize_url(publisher_article_id)
            if url_key in checked_urls:
                continue
            filtered_candidates.append(
                {
                    "datePublished": row.get("datePublished", ""),
                    "article": row.get("article", ""),
                    "author": row.get("author", ""),
                    "publisherArticleId": publisher_article_id,
                    "category": row.get("category", ""),
                    "totalEngagedMinutes": row.get("totalEngagedMinutes", ""),
                }
            )
        shortlist = filtered_candidates[:10]
        written = prepend_suggestions(output_ws, shortlist, today)
        log(f"Wrote {written} suggestions into {output_tab!r}.")
        log(f"Analyzer output saved in {run_dir}.")
    finally:
        try:
            os.unlink(temp_csv)
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
