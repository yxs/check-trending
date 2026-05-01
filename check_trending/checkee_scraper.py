from __future__ import annotations

import argparse
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


BASE_URL = "http://www.checkee.info"
PUBLIC_BASE_URL = "https://www.checkee.info"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
DETAIL_KEYS = {
    "Check Date",
    "Checkee CaseNum",
    "Complete Date",
    "Country",
    "Degree",
    "Employer",
    "First Name",
    "ID",
    "Job Title",
    "Last Name",
    "Major",
    "Note",
    "Status",
    "US Consulate",
    "University(College)",
    "Visa Entry",
    "Visa Type",
    "Years in Usa",
}


@dataclass(frozen=True)
class Cell:
    text: str
    links: tuple[str, ...]


@dataclass(frozen=True)
class CaseRecord:
    case_number: str
    display_id: str
    visa_type: str
    visa_entry: str
    consulate: str
    major: str
    status: str
    check_date: str
    complete_date: str | None
    waiting_days: int | None
    detail_url: str
    month: str
    source_url: str
    detail: dict[str, str] | None = None

    def with_detail(self, detail: dict[str, str]) -> "CaseRecord":
        return CaseRecord(**{**asdict(self), "detail": detail})

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[Cell]] = []
        self._row: list[Cell] | None = None
        self._cell_text: list[str] | None = None
        self._cell_links: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._row = []
            return
        if tag in {"td", "th"} and self._row is not None:
            self._cell_text = []
            self._cell_links = []
            return
        if tag == "a" and self._cell_links is not None:
            href = dict(attrs).get("href")
            if href:
                self._cell_links.append(href)

    def handle_data(self, data: str) -> None:
        if self._cell_text is not None:
            self._cell_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._row is not None and self._cell_text is not None:
            text = normalize_text(" ".join(self._cell_text))
            self._row.append(Cell(text=text, links=tuple(self._cell_links or ())))
            self._cell_text = None
            self._cell_links = None
            return
        if tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value)).strip()


def build_months(start: date, end: date) -> list[str]:
    months: list[str] = []
    year = start.year
    month = start.month
    while (year, month) <= (end.year, end.month):
        months.append(f"{year:04d}-{month:02d}")
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1
    return months


def parse_month_page(html: str, month: str, start_date: date) -> list[CaseRecord]:
    parser = TableParser()
    parser.feed(html)
    cases: list[CaseRecord] = []
    source_url = f"{PUBLIC_BASE_URL}/main.php?dispdate={month}"

    for row in parser.rows:
        if len(row) < 11:
            continue
        if row[0].text.lower() != "update":
            continue

        case_number = extract_case_number(row)
        if not case_number:
            continue

        check_date = row[7].text
        parsed_check_date = parse_date(check_date)
        if parsed_check_date is None or parsed_check_date < start_date:
            continue

        cases.append(
            CaseRecord(
                case_number=case_number,
                display_id=row[1].text,
                visa_type=row[2].text,
                visa_entry=row[3].text,
                consulate=row[4].text,
                major=row[5].text,
                status=row[6].text,
                check_date=check_date,
                complete_date=parse_optional_date(row[8].text),
                waiting_days=parse_int(row[9].text),
                detail_url=build_detail_url(case_number),
                month=month,
                source_url=source_url,
            )
        )

    return cases


def parse_detail_page(html: str, case_number: str) -> dict[str, str]:
    parser = TableParser()
    parser.feed(html)
    detail: dict[str, str] = {"case_number": case_number}

    for row in parser.rows:
        for cell in row:
            if ":" not in cell.text:
                continue
            key, value = cell.text.split(":", 1)
            normalized_key = key.strip()
            if normalized_key not in DETAIL_KEYS:
                continue
            normalized_value = value.strip()
            if normalized_key != "Checkee CaseNum":
                detail[normalized_key] = normalized_value

    detail["case_number"] = case_number
    return detail


def extract_case_number(row: list[Cell]) -> str | None:
    for cell in row:
        for link in cell.links:
            match = re.search(r"casenum=(\d+)", link)
            if match:
                return match.group(1)
    return None


def build_detail_url(case_number: str) -> str:
    return f"{PUBLIC_BASE_URL}/personal_detail.php?casenum={case_number}"


def parse_date(value: str) -> date | None:
    if value == "0000-00-00":
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_optional_date(value: str) -> str | None:
    return None if parse_date(value) is None else value


def parse_int(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


class PoliteHttpClient:
    def __init__(self, delay_seconds: float, jitter_seconds: float, retries: int, timeout: int) -> None:
        self.delay_seconds = delay_seconds
        self.jitter_seconds = jitter_seconds
        self.retries = retries
        self.timeout = timeout

    def fetch(self, url: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            self._sleep(attempt)
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.read().decode("utf-8", "ignore")
            except (TimeoutError, urllib.error.URLError, urllib.error.HTTPError) as error:
                last_error = error
                print(f"fetch failed attempt={attempt} url={url} error={error}", flush=True)
        raise RuntimeError(f"failed to fetch {url}") from last_error

    def _sleep(self, attempt: int) -> None:
        delay = self.delay_seconds + random.uniform(0, self.jitter_seconds)
        if attempt > 1:
            delay += min(60, 2 ** attempt)
        time.sleep(delay)


def crawl_checkee(
    start_date: date,
    end_date: date,
    output_dir: Path,
    delay_seconds: float,
    jitter_seconds: float,
    retries: int,
    timeout: int,
) -> list[CaseRecord]:
    output_dir.mkdir(parents=True, exist_ok=True)
    monthly_dir = output_dir / "raw" / "monthly"
    detail_dir = output_dir / "raw" / "details"
    monthly_dir.mkdir(parents=True, exist_ok=True)
    detail_dir.mkdir(parents=True, exist_ok=True)

    client = PoliteHttpClient(delay_seconds, jitter_seconds, retries, timeout)
    cases_by_number: dict[str, CaseRecord] = {}
    months = build_months(start_date, end_date)

    for month in months:
        month_url = f"{BASE_URL}/main.php?dispdate={month}"
        month_html_path = monthly_dir / f"{month}.html"
        month_html = read_or_fetch(month_html_path, month_url, client)
        month_cases = parse_month_page(month_html, month=month, start_date=start_date)
        print(f"month={month} cases={len(month_cases)}", flush=True)
        for case in month_cases:
            cases_by_number[case.case_number] = case

    total = len(cases_by_number)
    records: list[CaseRecord] = []
    for index, case in enumerate(sorted(cases_by_number.values(), key=lambda item: item.case_number), start=1):
        detail_html_path = detail_dir / f"{case.case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case.case_number}"
        detail_html = read_or_fetch(detail_html_path, detail_url, client)
        detail = parse_detail_page(detail_html, case.case_number)
        records.append(case.with_detail(detail))
        has_note = bool(detail.get("Note"))
        print(f"detail={index}/{total} case={case.case_number} note={has_note}", flush=True)

    write_outputs(records, output_dir, start_date, end_date)
    return records


def crawl_detail_range(
    start_date: date,
    end_date: date,
    output_dir: Path,
    case_number_start: int,
    case_number_end: int,
    delay_seconds: float,
    jitter_seconds: float,
    retries: int,
    timeout: int,
) -> list[CaseRecord]:
    output_dir.mkdir(parents=True, exist_ok=True)
    detail_dir = output_dir / "raw" / "details"
    detail_dir.mkdir(parents=True, exist_ok=True)

    client = PoliteHttpClient(delay_seconds, jitter_seconds, retries, timeout)
    records: list[CaseRecord] = []
    total = case_number_end - case_number_start + 1

    for offset, case_number_int in enumerate(range(case_number_start, case_number_end + 1), start=1):
        case_number = str(case_number_int)
        detail_html_path = detail_dir / f"{case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case_number}"
        detail_html = read_or_fetch(detail_html_path, detail_url, client)
        detail = parse_detail_page(detail_html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is not None:
            records.append(record)
        if offset % 25 == 0 or record is not None:
            status = "included" if record is not None else "scanned"
            print(f"{status}={offset}/{total} case={case_number} records={len(records)}", flush=True)

    records.sort(key=lambda item: (item.check_date, item.case_number))
    write_outputs(records, output_dir, start_date, end_date)
    write_range_summary(records, output_dir, start_date, end_date, case_number_start, case_number_end)
    return records


def case_from_detail(detail: dict[str, str], start_date: date, end_date: date) -> CaseRecord | None:
    check_date_value = detail.get("Check Date", "")
    check_date = parse_date(check_date_value)
    if check_date is None or check_date < start_date or check_date > end_date:
        return None

    complete_date_value = parse_optional_date(detail.get("Complete Date", ""))
    waiting_days = compute_waiting_days(check_date_value, complete_date_value, end_date)
    case_number = detail["case_number"]
    return CaseRecord(
        case_number=case_number,
        display_id=detail.get("ID", ""),
        visa_type=detail.get("Visa Type", ""),
        visa_entry=detail.get("Visa Entry", ""),
        consulate=detail.get("US Consulate", ""),
        major=detail.get("Major", ""),
        status=detail.get("Status", ""),
        check_date=check_date_value,
        complete_date=complete_date_value,
        waiting_days=waiting_days,
        detail_url=build_detail_url(case_number),
        month=check_date_value[:7],
        source_url=build_detail_url(case_number),
        detail=detail,
    )


def compute_waiting_days(check_date_value: str, complete_date_value: str | None, end_date: date) -> int | None:
    check_date = parse_date(check_date_value)
    if check_date is None:
        return None
    complete_date = parse_date(complete_date_value or "")
    terminal_date = complete_date or end_date
    return (terminal_date - check_date).days


def read_or_fetch(path: Path, url: str, client: PoliteHttpClient) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8", errors="ignore")
    html = client.fetch(url)
    path.write_text(html, encoding="utf-8")
    return html


def write_outputs(records: list[CaseRecord], output_dir: Path, start_date: date, end_date: date) -> None:
    prefix = f"checkee_cases_{start_date.isoformat()}_to_{end_date.isoformat()}"
    jsonl_path = output_dir / f"{prefix}.jsonl"
    json_path = output_dir / f"{prefix}.json"
    summary_path = output_dir / "crawl_summary.json"

    dictionaries = [record.to_dict() for record in records]
    with jsonl_path.open("w", encoding="utf-8") as jsonl_file:
        for item in dictionaries:
            jsonl_file.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")

    json_path.write_text(
        json.dumps(dictionaries, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    summary = {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "case_count": len(records),
        "detail_count": sum(1 for record in records if record.detail),
        "note_count": sum(1 for record in records if record.detail and record.detail.get("Note")),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def write_range_summary(
    records: list[CaseRecord],
    output_dir: Path,
    start_date: date,
    end_date: date,
    case_number_start: int,
    case_number_end: int,
) -> None:
    range_summary_path = output_dir / "detail_range_summary.json"
    summary = {
        "source": "personal_detail.php case-number range crawl",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "case_number_start": case_number_start,
        "case_number_end": case_number_end,
        "case_count": len(records),
        "note_count": sum(1 for record in records if record.detail and record.detail.get("Note")),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    range_summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Slowly crawl public Checkee.info case data.")
    parser.add_argument("--start-date", default="2025-07-01")
    parser.add_argument("--end-date", default=date.today().isoformat())
    parser.add_argument("--output-dir", default="data/checkee")
    parser.add_argument("--source", choices=("monthly", "detail-range"), default="detail-range")
    parser.add_argument("--case-number-start", type=int, default=842700)
    parser.add_argument("--case-number-end", type=int, default=845700)
    parser.add_argument("--delay-seconds", type=float, default=1.75)
    parser.add_argument("--jitter-seconds", type=float, default=1.25)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=30)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    if args.source == "monthly":
        crawl_checkee(
            start_date=start_date,
            end_date=end_date,
            output_dir=Path(args.output_dir),
            delay_seconds=args.delay_seconds,
            jitter_seconds=args.jitter_seconds,
            retries=args.retries,
            timeout=args.timeout,
        )
        return
    crawl_detail_range(
        start_date=start_date,
        end_date=end_date,
        output_dir=Path(args.output_dir),
        case_number_start=args.case_number_start,
        case_number_end=args.case_number_end,
        delay_seconds=args.delay_seconds,
        jitter_seconds=args.jitter_seconds,
        retries=args.retries,
        timeout=args.timeout,
    )


if __name__ == "__main__":
    main()
