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
from typing import Any, Callable


BASE_URL = "https://www.checkee.info"
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
CANONICAL_CASES_FILE = "checkee_cases.json"
MONTHLY_MANIFEST_FILE = "monthly_case_ids.json"
RECONCILIATION_REPORTS_DIR = Path("reports") / "reconciliation"
DETAIL_TABLE_START_MARKER = (
    '<' + 'table width="96%" border="1" align="center" cellspacing="0">'
)
DETAIL_TABLE_END_MARKER = '<' + '/table>'
LEGACY_DATA_FILE_PATTERN = re.compile(
    r"checkee_cases_(?P<start>\d{4}-\d{2}-\d{2})_to_(?P<end>\d{4}-\d{2}-\d{2})\.json$"
)
MONTHLY_BUFFER_DAY_OF_MONTH = 15
TERMINAL_STATUSES = frozenset({"Clear", "Reject"})


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


def parse_month_page(html: str, month: str, start_date: date, end_date: date | None = None) -> list[CaseRecord]:
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
        if end_date is not None and parsed_check_date > end_date:
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


def extract_detail_table_html(html: str) -> str | None:
    start = html.find(DETAIL_TABLE_START_MARKER)
    if start < 0:
        return None
    end = html.find(DETAIL_TABLE_END_MARKER, start)
    if end < 0:
        return None
    return html[start : end + len(DETAIL_TABLE_END_MARKER)]


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


def find_latest_legacy_source(output_dir: Path) -> Path | None:
    candidates: list[tuple[str, Path]] = []
    for path in output_dir.glob("checkee_cases_*_to_*.json"):
        match = LEGACY_DATA_FILE_PATTERN.match(path.name)
        if not match:
            continue
        candidates.append((match.group("end"), path))
    if not candidates:
        return None
    _, latest_path = max(candidates, key=lambda item: item[0])
    return latest_path


def find_existing_case_source(output_dir: Path) -> Path | None:
    canonical_path = output_dir / CANONICAL_CASES_FILE
    if canonical_path.exists():
        return canonical_path
    return find_latest_legacy_source(output_dir)


def get_max_known_case_number(output_dir: Path) -> int:
    _, max_case = get_known_case_bounds(output_dir)
    return max_case


def get_known_case_bounds(output_dir: Path) -> tuple[int, int]:
    source_path = find_existing_case_source(output_dir)
    if source_path is None:
        return (0, 0)
    try:
        records = json.loads(source_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return (0, 0)
    case_numbers: list[int] = []
    for record in records:
        try:
            case_numbers.append(int(str(record.get("case_number", "")).strip()))
        except ValueError:
            continue
    if not case_numbers:
        return (0, 0)
    return (min(case_numbers), max(case_numbers))


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


def sort_case_numbers(case_numbers: set[str] | list[str]) -> list[str]:
    return sorted(case_numbers, key=lambda value: int(value))


def previous_month_label(month_label: str) -> str:
    year = int(month_label[:4])
    month = int(month_label[5:7])
    if month == 1:
        return f"{year - 1:04d}-12"
    return f"{year:04d}-{month - 1:02d}"


def load_monthly_manifest(output_dir: Path) -> dict[str, list[str]]:
    path = output_dir / MONTHLY_MANIFEST_FILE
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return {
        str(month): [str(case_number) for case_number in case_numbers]
        for month, case_numbers in raw.items()
        if isinstance(case_numbers, list)
    }


def save_monthly_manifest(output_dir: Path, manifest: dict[str, list[str]]) -> None:
    path = output_dir / MONTHLY_MANIFEST_FILE
    normalized = {
        month: sort_case_numbers(case_numbers)
        for month, case_numbers in manifest.items()
    }
    payload = {month: normalized[month] for month in sorted(normalized.keys())}
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def determine_fetch_required_months(
    end_date: date,
    months: list[str],
    manifest: dict[str, list[str]],
    force_all: bool = False,
) -> set[str]:
    """Pick which monthly listings need a fresh main.php fetch.

    Always re-fetches the current month. Within the buffer window (day-of-month
    <= MONTHLY_BUFFER_DAY_OF_MONTH) also re-fetches the previous month so
    late-arriving submissions are caught. Months in scope that are not yet in
    the manifest are added too. ``force_all`` forces every in-scope month.
    """
    months_in_scope = set(months)
    if force_all:
        return set(months_in_scope)

    fetch_required: set[str] = set()
    current_month = f"{end_date.year:04d}-{end_date.month:02d}"
    fetch_required.add(current_month)
    if end_date.day <= MONTHLY_BUFFER_DAY_OF_MONTH:
        fetch_required.add(previous_month_label(current_month))

    for month in months:
        if month not in manifest:
            fetch_required.add(month)

    return fetch_required & months_in_scope


def crawl_checkee(
    start_date: date,
    end_date: date,
    output_dir: Path,
    delay_seconds: float,
    jitter_seconds: float,
    retries: int,
    timeout: int,
    refresh_monthly: bool,
    run_reconciliation: bool,
    probe_count: int,
    refresh_pending: bool = True,
    merge_with_canonical: bool = True,
    monthly_fetcher: Callable[[str], str] | None = None,
) -> list[CaseRecord]:
    output_dir.mkdir(parents=True, exist_ok=True)
    detail_dir = output_dir / "raw" / "details"
    detail_dir.mkdir(parents=True, exist_ok=True)

    client = PoliteHttpClient(delay_seconds, jitter_seconds, retries, timeout)
    monthly_fetch: Callable[[str], str] = monthly_fetcher or client.fetch
    months = build_months(start_date, end_date)
    manifest = load_monthly_manifest(output_dir)
    fetch_required = determine_fetch_required_months(
        end_date, months, manifest, force_all=refresh_monthly
    )

    cases_by_number: dict[str, CaseRecord] = {}
    all_known_case_numbers: set[str] = set()

    for month in months:
        if month in fetch_required:
            month_url = f"{BASE_URL}/main.php?dispdate={month}"
            month_html = monthly_fetch(month_url)
            month_cases = parse_month_page(
                month_html, month=month, start_date=start_date, end_date=end_date
            )
            print(f"month={month} cases={len(month_cases)} (fetched)", flush=True)
            manifest[month] = sort_case_numbers({case.case_number for case in month_cases})
            for case in month_cases:
                cases_by_number[case.case_number] = case
                all_known_case_numbers.add(case.case_number)
        else:
            month_case_numbers = manifest.get(month, [])
            print(f"month={month} cases={len(month_case_numbers)} (manifest)", flush=True)
            all_known_case_numbers.update(month_case_numbers)

    if not all_known_case_numbers:
        raise RuntimeError(
            "No monthly cases parsed and manifest is empty. "
            "Refusing to overwrite canonical dataset with empty results. "
            "Likely cause: Cloudflare challenge blocking main.php fetches "
            "or upstream HTML schema change."
        )

    save_monthly_manifest(output_dir, manifest)

    monthly_cases = [
        cases_by_number[case_number]
        for case_number in sort_case_numbers(set(cases_by_number.keys()))
    ]
    records = collect_records_for_monthly_cases(
        monthly_cases=monthly_cases,
        start_date=start_date,
        end_date=end_date,
        detail_dir=detail_dir,
        client=client,
    )

    if refresh_pending:
        refreshed = refresh_pending_in_canonical(
            output_dir=output_dir,
            detail_dir=detail_dir,
            client=client,
            start_date=start_date,
            end_date=end_date,
            skip_case_numbers={record.case_number for record in records},
        )
        records_by_number = {record.case_number: record for record in records}
        for case_number, record in refreshed.items():
            records_by_number[case_number] = record
        records = sorted(
            records_by_number.values(), key=lambda item: (item.check_date, item.case_number)
        )

    if run_reconciliation:
        reconciliation = run_id_reconciliation(
            output_dir=output_dir,
            detail_dir=detail_dir,
            client=client,
            start_date=start_date,
            end_date=end_date,
            all_known_case_numbers=all_known_case_numbers,
            probe_count=probe_count,
        )
        if reconciliation.brute_force_only_records:
            records_by_number = {record.case_number: record for record in records}
            for case_number, record in reconciliation.brute_force_only_records.items():
                records_by_number[case_number] = record
            records = sorted(
                records_by_number.values(),
                key=lambda item: (item.check_date, item.case_number),
            )

    write_outputs(
        records,
        output_dir,
        start_date,
        end_date,
        merge_with_canonical=merge_with_canonical,
    )
    return records


def collect_records_for_monthly_cases(
    monthly_cases: list[CaseRecord],
    start_date: date,
    end_date: date,
    detail_dir: Path,
    client: PoliteHttpClient,
) -> list[CaseRecord]:
    records: list[CaseRecord] = []
    total = len(monthly_cases)

    for index, monthly_case in enumerate(monthly_cases, start=1):
        case_number = monthly_case.case_number
        detail_html_path = detail_dir / f"{case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case_number}"
        cached_html = detail_html_path.read_text(encoding="utf-8", errors="ignore") if detail_html_path.exists() else None
        cached_record = None
        if cached_html is not None:
            cached_detail = parse_detail_page(cached_html, case_number)
            cached_record = case_from_detail(cached_detail, start_date, end_date)

        force_fetch = cached_html is None or cached_record is None
        if cached_record is not None and cached_record.status not in TERMINAL_STATUSES:
            force_fetch = True

        try:
            detail_html = read_or_fetch(
                detail_html_path,
                detail_url,
                client,
                force_fetch=force_fetch,
                trim_detail_html=True,
            )
        except RuntimeError:
            if cached_html is not None:
                detail_html = cached_html
                print(f"using cached detail for case={case_number} after fetch failure", flush=True)
            else:
                detail_html = ""
                print(f"using monthly fallback for case={case_number} after fetch failure", flush=True)

        detail = parse_detail_page(detail_html, case_number) if detail_html else {"case_number": case_number}
        record = case_from_detail(detail, start_date, end_date)
        if record is None:
            if cached_record is not None:
                record = cached_record
            else:
                # Keep monthly-list coverage when detail page has transient issues.
                record = monthly_case.with_detail({"case_number": case_number, "Note": detail.get("Note", "")})
        records.append(record)
        has_note = bool(record.detail and record.detail.get("Note"))
        print(f"detail={index}/{total} case={case_number} note={has_note}", flush=True)

    records.sort(key=lambda item: (item.check_date, item.case_number))
    return records


def discover_case_numbers_by_range(
    start_date: date,
    end_date: date,
    detail_dir: Path,
    client: PoliteHttpClient,
    scan_start_case: int,
    scan_end_case: int,
    known_max_case: int,
) -> tuple[set[str], dict[str, CaseRecord]]:
    discovered: set[str] = set()
    discovered_records: dict[str, CaseRecord] = {}
    total = scan_end_case - scan_start_case + 1
    print(
        f"reconciliation_scan start={scan_start_case} end={scan_end_case} total={total} known_max={known_max_case}",
        flush=True,
    )

    for offset, case_number_int in enumerate(range(scan_start_case, scan_end_case + 1), start=1):
        case_number = str(case_number_int)
        detail_html_path = detail_dir / f"{case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case_number}"
        cached_html = detail_html_path.read_text(encoding="utf-8", errors="ignore") if detail_html_path.exists() else None
        cached_record = None
        if cached_html is not None:
            cached_detail = parse_detail_page(cached_html, case_number)
            cached_record = case_from_detail(cached_detail, start_date, end_date)

        force_fetch = cached_html is None or cached_record is None or case_number_int > known_max_case
        try:
            detail_html = read_or_fetch(
                detail_html_path,
                detail_url,
                client,
                force_fetch=force_fetch,
                trim_detail_html=True,
            )
        except RuntimeError:
            if cached_html is not None:
                detail_html = cached_html
            else:
                continue

        detail = parse_detail_page(detail_html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is not None:
            discovered.add(case_number)
            discovered_records[case_number] = record

        if offset % 100 == 0:
            print(
                f"reconciliation_progress scanned={offset}/{total} discovered={len(discovered)}",
                flush=True,
            )

    return discovered, discovered_records


@dataclass(frozen=True)
class ReconciliationResult:
    monthly_case_numbers: frozenset[str]
    brute_force_case_numbers: frozenset[str]
    brute_force_only_records: dict[str, CaseRecord]
    scan_start_case: int
    scan_end_case: int


def run_id_reconciliation(
    output_dir: Path,
    detail_dir: Path,
    client: PoliteHttpClient,
    start_date: date,
    end_date: date,
    all_known_case_numbers: set[str],
    probe_count: int,
) -> ReconciliationResult:
    known_min_case, known_max_case = get_known_case_bounds(output_dir)
    monthly_case_numbers_int = [int(case_number) for case_number in all_known_case_numbers]

    if monthly_case_numbers_int:
        scan_start_candidates = [min(monthly_case_numbers_int)]
        if known_min_case > 0:
            scan_start_candidates.append(known_min_case)
        scan_start_case = min(scan_start_candidates)
        scan_end_case = max(max(monthly_case_numbers_int), known_max_case) + max(0, probe_count)
    else:
        scan_start_case = known_min_case if known_min_case > 0 else 0
        scan_end_case = known_max_case + max(0, probe_count)

    brute_force_case_numbers, brute_force_records = discover_case_numbers_by_range(
        start_date=start_date,
        end_date=end_date,
        detail_dir=detail_dir,
        client=client,
        scan_start_case=scan_start_case,
        scan_end_case=scan_end_case,
        known_max_case=known_max_case,
    )

    monthly_only = sort_case_numbers(all_known_case_numbers - brute_force_case_numbers)
    brute_force_only_sorted = sort_case_numbers(brute_force_case_numbers - all_known_case_numbers)
    brute_force_only_records = {
        case_number: brute_force_records[case_number]
        for case_number in brute_force_only_sorted
        if case_number in brute_force_records
    }

    report_dir = output_dir / RECONCILIATION_REPORTS_DIR
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"{end_date.strftime('%Y-%m')}.json"

    report = {
        "source": "monthly-vs-detail-range-id-reconciliation",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "scan_start_case": scan_start_case,
        "scan_end_case": scan_end_case,
        "probe_count": probe_count,
        "monthly_case_count": len(all_known_case_numbers),
        "brute_force_case_count": len(brute_force_case_numbers),
        "matched_case_count": len(set(all_known_case_numbers) & brute_force_case_numbers),
        "monthly_only_case_count": len(monthly_only),
        "brute_force_only_case_count": len(brute_force_only_sorted),
        "monthly_only_case_numbers": monthly_only,
        "brute_force_only_case_numbers": brute_force_only_sorted,
        "auto_merged_count": len(brute_force_only_records),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(
        "reconciliation_result "
        f"monthly={report['monthly_case_count']} "
        f"brute_force={report['brute_force_case_count']} "
        f"matched={report['matched_case_count']} "
        f"monthly_only={report['monthly_only_case_count']} "
        f"brute_force_only={report['brute_force_only_case_count']} "
        f"auto_merged={report['auto_merged_count']}",
        flush=True,
    )

    return ReconciliationResult(
        monthly_case_numbers=frozenset(all_known_case_numbers),
        brute_force_case_numbers=frozenset(brute_force_case_numbers),
        brute_force_only_records=brute_force_only_records,
        scan_start_case=scan_start_case,
        scan_end_case=scan_end_case,
    )


def refresh_pending_in_canonical(
    output_dir: Path,
    detail_dir: Path,
    client: PoliteHttpClient,
    start_date: date,
    end_date: date,
    skip_case_numbers: set[str] | None = None,
) -> dict[str, CaseRecord]:
    """Force re-fetch detail pages for canonical cases not yet in a terminal status.

    Cases listed in ``skip_case_numbers`` are bypassed (typically those already
    refreshed by the monthly path during the same run).
    """
    canonical_path = output_dir / CANONICAL_CASES_FILE
    if not canonical_path.exists():
        return {}
    try:
        existing = json.loads(canonical_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}

    skip = skip_case_numbers or set()
    targets: list[str] = []
    for record in existing:
        case_number = str(record.get("case_number", ""))
        if not case_number or case_number in skip:
            continue
        if record.get("status") in TERMINAL_STATUSES:
            continue
        targets.append(case_number)

    if not targets:
        return {}

    print(f"refresh_pending: scanning {len(targets)} non-terminal cases", flush=True)
    refreshed: dict[str, CaseRecord] = {}
    for index, case_number in enumerate(targets, start=1):
        detail_html_path = detail_dir / f"{case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case_number}"
        try:
            detail_html = read_or_fetch(
                detail_html_path,
                detail_url,
                client,
                force_fetch=True,
                trim_detail_html=True,
            )
        except RuntimeError:
            print(f"refresh_pending: skip case={case_number} after fetch failure", flush=True)
            continue
        detail = parse_detail_page(detail_html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is not None:
            refreshed[case_number] = record
        if index % 25 == 0:
            print(
                f"refresh_pending: {index}/{len(targets)} processed (refreshed={len(refreshed)})",
                flush=True,
            )
    print(
        f"refresh_pending: done refreshed={len(refreshed)}/{len(targets)}",
        flush=True,
    )
    return refreshed


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
    max_known_case = get_max_known_case_number(output_dir)
    print(f"max_known_case={max_known_case}", flush=True)
    records: list[CaseRecord] = []
    total = case_number_end - case_number_start + 1

    for offset, case_number_int in enumerate(range(case_number_start, case_number_end + 1), start=1):
        case_number = str(case_number_int)
        detail_html_path = detail_dir / f"{case_number}.html"
        detail_url = f"{BASE_URL}/personal_detail.php?casenum={case_number}"
        cached_html = detail_html_path.read_text(encoding="utf-8", errors="ignore") if detail_html_path.exists() else None
        cached_record = None
        if cached_html is not None:
            cached_detail = parse_detail_page(cached_html, case_number)
            cached_record = case_from_detail(cached_detail, start_date, end_date)
        should_refresh_pending = cached_record is not None and cached_record.status not in TERMINAL_STATUSES
        should_probe_frontier = case_number_int > max_known_case
        force_fetch = cached_html is None or should_refresh_pending or should_probe_frontier
        try:
            detail_html = read_or_fetch(
                detail_html_path,
                detail_url,
                client,
                force_fetch=force_fetch,
                trim_detail_html=True,
            )
        except RuntimeError:
            if cached_html is not None:
                detail_html = cached_html
                print(f"using cached detail for case={case_number} after fetch failure", flush=True)
            else:
                print(f"skipped case={case_number} because fetch failed and no cache was found", flush=True)
                continue
        detail = parse_detail_page(detail_html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is not None:
            records.append(record)
        if offset % 25 == 0 or record is not None:
            status = "included" if record is not None else "scanned"
            print(f"{status}={offset}/{total} case={case_number} records={len(records)}", flush=True)

    records.sort(key=lambda item: (item.check_date, item.case_number))
    write_outputs(records, output_dir, start_date, end_date)
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


def read_or_fetch(
    path: Path,
    url: str,
    client: PoliteHttpClient,
    force_fetch: bool = False,
    trim_detail_html: bool = False,
) -> str:
    if path.exists() and not force_fetch:
        cached_html = path.read_text(encoding="utf-8", errors="ignore")
        if trim_detail_html:
            compact_html = extract_detail_table_html(cached_html)
            if compact_html is not None and compact_html != cached_html:
                path.write_text(compact_html, encoding="utf-8")
                return compact_html
        return cached_html
    html = client.fetch(url)
    if trim_detail_html:
        compact_html = extract_detail_table_html(html)
        if compact_html is not None:
            html = compact_html
    path.write_text(html, encoding="utf-8")
    return html


def write_outputs(
    records: list[CaseRecord],
    output_dir: Path,
    start_date: date,
    end_date: date,
    merge_with_canonical: bool = False,
) -> None:
    json_path = output_dir / CANONICAL_CASES_FILE
    summary_path = output_dir / "crawl_summary.json"

    new_dictionaries = [record.to_dict() for record in records]
    if merge_with_canonical and json_path.exists():
        try:
            existing = json.loads(json_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = []
        merged_by_number: dict[str, dict[str, Any]] = {
            str(record.get("case_number", "")): record
            for record in existing
            if record.get("case_number")
        }
        for record_dict in new_dictionaries:
            merged_by_number[str(record_dict["case_number"])] = record_dict
        dictionaries = sorted(
            merged_by_number.values(),
            key=lambda record: (
                record.get("check_date", ""),
                str(record.get("case_number", "")),
            ),
        )
    else:
        dictionaries = new_dictionaries

    json_path.write_text(
        json.dumps(dictionaries, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    summary = {
        **_summary_range(dictionaries, start_date, end_date),
        "case_count": len(dictionaries),
        "detail_count": sum(1 for record in dictionaries if record.get("detail")),
        "note_count": sum(
            1
            for record in dictionaries
            if record.get("detail") and record["detail"].get("Note")
        ),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _summary_range(
    dictionaries: list[dict[str, Any]],
    start_date: date,
    end_date: date,
) -> dict[str, str]:
    """Compute summary start/end that contain every observed check/complete date."""
    observed: list[str] = []
    for record in dictionaries:
        check_date_value = record.get("check_date")
        if isinstance(check_date_value, str) and check_date_value:
            observed.append(check_date_value)
        complete_date_value = record.get("complete_date")
        if isinstance(complete_date_value, str) and complete_date_value:
            observed.append(complete_date_value)

    if not observed:
        return {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        }

    return {
        "start_date": min(start_date.isoformat(), min(observed)),
        "end_date": max(end_date.isoformat(), max(observed)),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Slowly crawl public Checkee.info case data.")
    parser.add_argument("--start-date", default="2025-07-01")
    parser.add_argument("--end-date", default=date.today().isoformat())
    parser.add_argument("--output-dir", default="data/checkee")
    parser.add_argument("--source", choices=("monthly", "detail-range"), default="monthly")
    parser.add_argument(
        "--mode",
        choices=("daily", "reconcile"),
        default="daily",
        help=(
            "daily: monthly fetch (current+buffer) + pending refresh + canonical merge. "
            "reconcile: also run detail-range ID reconciliation with auto-merge of "
            "brute-force-only IDs."
        ),
    )
    parser.add_argument("--case-number-start", type=int)
    parser.add_argument("--case-number-end", type=int)
    parser.add_argument(
        "--run-reconciliation",
        action="store_true",
        help="Deprecated; prefer --mode reconcile (kept for backward compatibility).",
    )
    parser.add_argument("--probe-count", type=int, default=40)
    parser.add_argument("--delay-seconds", type=float, default=1.75)
    parser.add_argument("--jitter-seconds", type=float, default=1.25)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--refresh-monthly",
        action="store_true",
        help=(
            "Force re-fetch every month in scope (overrides manifest cache). "
            "Useful for the very first bootstrap or when the manifest is suspected stale."
        ),
    )
    parser.add_argument(
        "--no-refresh-pending",
        action="store_true",
        help="Disable force-refresh of canonical cases that are not in a terminal status.",
    )
    parser.add_argument(
        "--no-merge-with-canonical",
        action="store_true",
        help=(
            "Disable merging into the existing canonical dataset (default writes merged "
            "results, preserving cases outside this run's scope)."
        ),
    )
    parser.add_argument(
        "--monthly-fetcher",
        choices=("urllib", "browser"),
        default="urllib",
        help=(
            "Transport for main.php?dispdate=... fetches. 'urllib' is plain HTTP "
            "(blocked by Cloudflare in production). 'browser' uses patchright + "
            "system Chrome to solve the JS challenge (pair with xvfb-run on Linux)."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    run_reconciliation = args.run_reconciliation or args.mode == "reconcile"
    refresh_pending = not args.no_refresh_pending
    merge_with_canonical = not args.no_merge_with_canonical

    if args.source == "monthly":
        if args.monthly_fetcher == "browser":
            from check_trending.cf_fetcher import BrowserFetcher

            with BrowserFetcher() as browser:
                crawl_checkee(
                    start_date=start_date,
                    end_date=end_date,
                    output_dir=Path(args.output_dir),
                    delay_seconds=args.delay_seconds,
                    jitter_seconds=args.jitter_seconds,
                    retries=args.retries,
                    timeout=args.timeout,
                    refresh_monthly=args.refresh_monthly,
                    run_reconciliation=run_reconciliation,
                    probe_count=args.probe_count,
                    refresh_pending=refresh_pending,
                    merge_with_canonical=merge_with_canonical,
                    monthly_fetcher=browser.fetch,
                )
            return
        crawl_checkee(
            start_date=start_date,
            end_date=end_date,
            output_dir=Path(args.output_dir),
            delay_seconds=args.delay_seconds,
            jitter_seconds=args.jitter_seconds,
            retries=args.retries,
            timeout=args.timeout,
            refresh_monthly=args.refresh_monthly,
            run_reconciliation=run_reconciliation,
            probe_count=args.probe_count,
            refresh_pending=refresh_pending,
            merge_with_canonical=merge_with_canonical,
        )
        return
    if args.case_number_start is None or args.case_number_end is None:
        raise ValueError("detail-range source requires both --case-number-start and --case-number-end")
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
