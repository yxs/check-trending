"""Checkee.info scraper with two clean paths.

Path 1 — Daily Refresh (`daily` subcommand, runs in CI):
  detail-page only (no main.php → no Cloudflare). Each run does:
    * Frontier probe: scan max_known+1 .. max_known+probe_count to find new
      case_numbers.
    * Pending bucket: refresh canonical Pending where case_number % 3 == today's
      weekday-derived bucket. With Tue/Thu/Sat schedule, every Pending case is
      refreshed exactly once per week.

Path 2 — Manual Calibration (`calibrate` subcommand, runs locally):
  Headed browser, hits main.php (Cloudflare-gated). Each run does:
    * Decide which months to fetch (current + previous always; earlier months
      only if not previously calibrated, per `monthly_calibration_log.json`).
    * Fetch listings → update `monthly_case_ids.json`.
    * Diff vs canonical → fetch any missed detail pages via PoliteHttpClient.
    * Write reconciliation report.

Detail pages have NO Cloudflare challenge (verified empirically), but they are
behaviorally rate-limited; ~0.2 req/s sustained is the soft cap. Stay polite.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo


# =============================================================================
# Constants
# =============================================================================

BASE_URL = "https://www.checkee.info"

# curl_cffi impersonation targets — rotate per session, not per request, so the
# TLS/JA3/JA4 fingerprint stays consistent within a session (mismatched JA3 +
# UA looks more bot-like than either alone). Each entry is a curl_cffi
# `impersonate` profile that shapes TLS extensions, HTTP/2 SETTINGS, and the
# default header order to match a real browser build.
IMPERSONATE_POOL: tuple[str, ...] = (
    "chrome124",
    "chrome123",
    "chrome120",
    "safari17_0",
    "edge101",
)

# Kept only because tests assert pool size; UA is now driven by curl_cffi's
# impersonation profile, not by manual rotation.
USER_AGENT_POOL: tuple[str, ...] = IMPERSONATE_POOL

DETAIL_KEYS = frozenset({
    "Check Date", "Checkee CaseNum", "Complete Date", "Country", "Degree",
    "Employer", "First Name", "ID", "Job Title", "Last Name", "Major", "Note",
    "Status", "US Consulate", "University(College)", "Visa Entry", "Visa Type",
    "Years in Usa",
})

CANONICAL_CASES_FILE = "checkee_cases.json"
MONTHLY_MANIFEST_FILE = "monthly_case_ids.json"
CALIBRATION_LOG_FILE = "monthly_calibration_log.json"
SUMMARY_FILE = "crawl_summary.json"
RECONCILIATION_REPORTS_DIR = Path("reports") / "reconciliation"

# Marker pair used to trim detail HTML down to the case-info table only.
# The literal table-open tag is split across concat to avoid blob tools mis-
# detecting this source file as a detail-page during history rewrites.
DETAIL_TABLE_START_MARKER = (
    "<" + 'table width="96%" border="1" align="center" cellspacing="0">'
)
DETAIL_TABLE_END_MARKER = "<" + "/table>"

TERMINAL_STATUSES = frozenset({"Clear", "Reject"})

# Default project-wide data window. Anything before this is out of scope.
DEFAULT_START_DATE = date(2025, 7, 1)

# Bucket selection uses Beijing weekday so the scheduled mapping holds
# regardless of runner timezone. CI runs in UTC; the cron `37 18 * * 1,3,5`
# fires Mon/Wed/Fri 18:37 UTC, which is Tue/Thu/Sat 02:37 Beijing.
BEIJING_TZ = ZoneInfo("Asia/Shanghai")


# =============================================================================
# Exceptions
# =============================================================================

class FetchError(Exception):
    """A single fetch failed after all retries; caller decides what to do."""


class CircuitBreakerError(Exception):
    """Too many consecutive fetch failures — abort the entire run."""


# =============================================================================
# Dataclasses
# =============================================================================

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


@dataclass
class RunStats:
    """Per-run counters surfaced to logs and the GitHub workflow summary."""
    attempts: int = 0
    successes: int = 0
    failures: int = 0
    new_cases_discovered: int = 0
    pending_refreshed: int = 0
    pending_status_changed: int = 0
    skipped_terminal: int = 0
    skipped_out_of_bucket: int = 0

    @property
    def failure_rate(self) -> float:
        if self.attempts == 0:
            return 0.0
        return self.failures / self.attempts

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["failure_rate_pct"] = round(self.failure_rate * 100, 2)
        return d


# =============================================================================
# HTML parsing  (kept verbatim — these are the stable parts)
# =============================================================================

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


def parse_month_page(
    html: str,
    month: str,
    start_date: date,
    end_date: date | None = None,
) -> list[CaseRecord]:
    parser = TableParser()
    parser.feed(html)
    cases: list[CaseRecord] = []
    source_url = f"{BASE_URL}/main.php?dispdate={month}"

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
    return f"{BASE_URL}/personal_detail.php?casenum={case_number}"


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


# =============================================================================
# Date helpers
# =============================================================================

def build_months(start: date, end: date) -> list[str]:
    months: list[str] = []
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        months.append(f"{year:04d}-{month:02d}")
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1
    return months


def previous_month_label(month_label: str) -> str:
    year = int(month_label[:4])
    month = int(month_label[5:7])
    if month == 1:
        return f"{year - 1:04d}-12"
    return f"{year:04d}-{month - 1:02d}"


# =============================================================================
# Storage
# =============================================================================

def find_existing_case_source(output_dir: Path) -> Path | None:
    canonical_path = output_dir / CANONICAL_CASES_FILE
    return canonical_path if canonical_path.exists() else None


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


def get_max_known_case_number(output_dir: Path) -> int:
    return get_known_case_bounds(output_dir)[1]


def sort_case_numbers(case_numbers: set[str] | list[str]) -> list[str]:
    return sorted(case_numbers, key=lambda value: int(value))


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


def load_calibration_log(output_dir: Path) -> dict[str, str]:
    """Returns {month_label: ISO date this month was last calibrated}."""
    path = output_dir / CALIBRATION_LOG_FILE
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}


def save_calibration_log(output_dir: Path, log: dict[str, str]) -> None:
    path = output_dir / CALIBRATION_LOG_FILE
    payload = {month: log[month] for month in sorted(log.keys())}
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def determine_calibration_targets(
    today: date,
    available_months: Iterable[str],
    log: dict[str, str],
) -> list[str]:
    """Pick which months to (re)calibrate.

    Hard rule: current month + previous month always.
    Earlier months: only if not present in `log`.

    Day-of-month does not enter the decision — we always cover the buffer
    window via the "previous month always" rule.
    """
    current = f"{today.year:04d}-{today.month:02d}"
    prev = previous_month_label(current)

    must = {current, prev}
    available = set(available_months) | must
    needs_first_calibration = {m for m in available if m not in log}

    targets = (must | needs_first_calibration) & available
    return sorted(targets)


# =============================================================================
# HTTP client
# =============================================================================

class PoliteHttpClient:
    """Polite HTTP client with browser TLS impersonation (via curl_cffi),
    jitter, long pauses, and a consecutive-failure circuit breaker.

    Cloudflare bot management on checkee.info combines IP reputation with
    JA3/JA4 TLS fingerprinting and HTTP/2 SETTINGS comparison. Plain urllib
    presents a Python TLS fingerprint that, when combined with the Azure
    egress IPs that GitHub-hosted runners use, scores high enough to get a
    blanket 403. curl_cffi impersonates a real Chrome/Safari TLS handshake,
    which clears the fingerprint signal and lets the request through.

    The defaults are sized for ≤ 0.2 req/s sustained — well below the
    empirically-measured behavioral throttle threshold.
    """

    def __init__(
        self,
        delay_seconds: float = 3.0,
        jitter_seconds: float = 4.0,
        retries: int = 1,
        timeout: int = 30,
        long_pause_every: int = 25,
        long_pause_min: float = 15.0,
        long_pause_max: float = 45.0,
        consecutive_failure_limit: int = 5,
        impersonate_profiles: Iterable[str] = IMPERSONATE_POOL,
    ) -> None:
        self.delay_seconds = delay_seconds
        self.jitter_seconds = jitter_seconds
        self.retries = retries
        self.timeout = timeout
        self.long_pause_every = long_pause_every
        self.long_pause_min = long_pause_min
        self.long_pause_max = long_pause_max
        self.consecutive_failure_limit = consecutive_failure_limit
        self._impersonate_profiles = tuple(impersonate_profiles)
        self._fetch_count = 0
        self._consecutive_failures = 0
        self._session: Any = None
        self._session_impersonate: str = ""

    def _ensure_session(self) -> None:
        if self._session is not None:
            return
        try:
            from curl_cffi import requests as cffi_requests
        except ImportError as error:
            raise RuntimeError(
                "curl_cffi is required for the daily scraper; install with "
                "`pip install curl_cffi`"
            ) from error
        # Pick one profile per session so JA3/JA4 stays consistent across
        # the run — mid-session fingerprint flips are themselves a tell.
        profile = (
            random.choice(self._impersonate_profiles)
            if self._impersonate_profiles
            else "chrome124"
        )
        self._session = cffi_requests.Session(impersonate=profile)
        self._session_impersonate = profile
        print(f"http_session impersonate={profile}", flush=True)

    def fetch(self, url: str) -> str:
        self._fetch_count += 1
        if self._fetch_count > 1 and (self._fetch_count - 1) % self.long_pause_every == 0:
            self._long_pause()

        self._ensure_session()
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            self._sleep(attempt)
            try:
                response = self._session.get(url, timeout=self.timeout)
                if response.status_code == 200:
                    self._consecutive_failures = 0
                    return response.text
                last_error = FetchError(
                    f"HTTP {response.status_code} for {url}"
                )
                print(
                    f"fetch failed attempt={attempt} url={url} "
                    f"status={response.status_code} impersonate={self._session_impersonate}",
                    flush=True,
                )
            except Exception as error:  # noqa: BLE001 — curl_cffi raises a wide tree
                last_error = error
                print(
                    f"fetch failed attempt={attempt} url={url} status=- "
                    f"error={type(error).__name__}: {error}",
                    flush=True,
                )

        self._consecutive_failures += 1
        if self._consecutive_failures >= self.consecutive_failure_limit:
            raise CircuitBreakerError(
                f"{self._consecutive_failures} consecutive fetch failures; "
                f"last url={url}"
            )
        raise FetchError(f"failed to fetch {url}") from last_error

    def _sleep(self, attempt: int) -> None:
        delay = self.delay_seconds + random.uniform(0, self.jitter_seconds)
        if attempt > 1:
            delay += min(30, 2 ** attempt)
        time.sleep(delay)

    def _long_pause(self) -> None:
        pause = random.uniform(self.long_pause_min, self.long_pause_max)
        print(
            f"long_pause seconds={pause:.1f} after_fetches={self._fetch_count - 1}",
            flush=True,
        )
        time.sleep(pause)


# =============================================================================
# Detail-page → CaseRecord
# =============================================================================

def case_from_detail(
    detail: dict[str, str], start_date: date, end_date: date
) -> CaseRecord | None:
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


def compute_waiting_days(
    check_date_value: str, complete_date_value: str | None, end_date: date
) -> int | None:
    check_date = parse_date(check_date_value)
    if check_date is None:
        return None
    complete_date = parse_date(complete_date_value or "")
    terminal_date = complete_date or end_date
    return (terminal_date - check_date).days


def fetch_and_cache_detail(
    case_number: str,
    detail_dir: Path,
    client: PoliteHttpClient,
) -> str:
    """Fetch one detail page, trim to detail-table HTML, and persist to cache.

    Raises FetchError on permanent failure (CircuitBreakerError propagates).
    """
    detail_path = detail_dir / f"{case_number}.html"
    detail_url = build_detail_url(case_number)
    html = client.fetch(detail_url)
    compact = extract_detail_table_html(html)
    if compact is not None:
        html = compact
    detail_path.write_text(html, encoding="utf-8")
    return html


# =============================================================================
# Path 1: Daily Refresh
# =============================================================================

# Tue (1) → bucket 0, Thu (3) → bucket 1, Sat (5) → bucket 2.
# Other weekdays (manual dispatch) fall back to bucket 0.
_WEEKDAY_TO_BUCKET = {1: 0, 3: 1, 5: 2}
NUM_PENDING_BUCKETS = 3


def weekday_to_bucket(weekday: int) -> int:
    return _WEEKDAY_TO_BUCKET.get(weekday, 0)


def select_pending_for_bucket(
    canonical: list[dict[str, Any]], bucket: int, num_buckets: int = NUM_PENDING_BUCKETS
) -> list[str]:
    """Return canonical case_numbers that are non-terminal and fall in bucket.

    Bucket assignment is deterministic by `int(case_number) % num_buckets`,
    ensuring each Pending case is visited in exactly one bucket per cycle.
    """
    selected: list[str] = []
    for record in canonical:
        if record.get("status") in TERMINAL_STATUSES:
            continue
        case_number_str = str(record.get("case_number", "")).strip()
        try:
            case_number_int = int(case_number_str)
        except ValueError:
            continue
        if case_number_int % num_buckets != bucket:
            continue
        selected.append(case_number_str)
    return sort_case_numbers(selected)


def crawl_daily(
    *,
    start_date: date,
    end_date: date,
    output_dir: Path,
    probe_count: int,
    bucket: int,
    client: PoliteHttpClient,
    fetch_budget: int,
) -> RunStats:
    """Path 1: detail-only refresh.

    Refreshes the bucket-selected Pending cases, then frontier-probes for new
    cases above `max_known`. No main.php. No silent fallback to cache: a fetch
    failure leaves the canonical record untouched and is counted.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    detail_dir = output_dir / "raw" / "details"
    detail_dir.mkdir(parents=True, exist_ok=True)

    canonical_path = output_dir / CANONICAL_CASES_FILE
    canonical: list[dict[str, Any]] = []
    if canonical_path.exists():
        try:
            canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            canonical = []

    canonical_by_number: dict[str, dict[str, Any]] = {
        str(r.get("case_number", "")): r for r in canonical if r.get("case_number")
    }

    stats = RunStats()
    max_known = get_max_known_case_number(output_dir)

    pending_targets = select_pending_for_bucket(canonical, bucket)
    print(
        f"daily_run start bucket={bucket} pending_in_bucket={len(pending_targets)} "
        f"max_known={max_known} probe_count={probe_count} budget={fetch_budget}",
        flush=True,
    )

    refresh_targets = list(pending_targets)
    random.shuffle(refresh_targets)

    # ---- Pending bucket refresh ----
    for case_number in refresh_targets:
        if stats.attempts >= fetch_budget:
            print(f"fetch_budget_reached attempts={stats.attempts}", flush=True)
            break
        stats.attempts += 1
        prev_record = canonical_by_number.get(case_number)
        prev_status = prev_record.get("status") if prev_record else None
        try:
            html = fetch_and_cache_detail(case_number, detail_dir, client)
        except FetchError:
            stats.failures += 1
            continue
        stats.successes += 1
        stats.pending_refreshed += 1
        detail = parse_detail_page(html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is None:
            continue
        canonical_by_number[case_number] = record.to_dict()
        if record.status != prev_status:
            stats.pending_status_changed += 1
            print(
                f"pending_status_change case={case_number} {prev_status}→{record.status}",
                flush=True,
            )

    # ---- Frontier probe ----
    probe_start = max_known + 1
    probe_end = max_known + max(0, probe_count)
    probe_range = list(range(probe_start, probe_end + 1))
    random.shuffle(probe_range)
    for case_number_int in probe_range:
        if stats.attempts >= fetch_budget:
            print(f"fetch_budget_reached attempts={stats.attempts}", flush=True)
            break
        case_number = str(case_number_int)
        if case_number in canonical_by_number:
            continue
        stats.attempts += 1
        try:
            html = fetch_and_cache_detail(case_number, detail_dir, client)
        except FetchError:
            stats.failures += 1
            continue
        stats.successes += 1
        detail = parse_detail_page(html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is None:
            # Case_number doesn't exist or check_date out of range. Treat as
            # quiet — the placeholder page returns 200 but parses to no record.
            continue
        canonical_by_number[case_number] = record.to_dict()
        stats.new_cases_discovered += 1
        print(f"new_case_discovered case={case_number}", flush=True)

    # ---- Write merged canonical ----
    merged = sorted(
        canonical_by_number.values(),
        key=lambda r: (r.get("check_date", ""), str(r.get("case_number", ""))),
    )
    write_outputs(
        records=None,
        output_dir=output_dir,
        start_date=start_date,
        end_date=end_date,
        merged_records=merged,
    )
    return stats


# =============================================================================
# Path 2: Manual Calibration
# =============================================================================

def crawl_calibrate(
    *,
    start_date: date,
    end_date: date,
    output_dir: Path,
    monthly_fetcher: Callable[[str], str],
    detail_client: PoliteHttpClient,
) -> dict[str, Any]:
    """Path 2: monthly-listing calibration via headed browser.

    Decides which months to fetch using `monthly_calibration_log.json`; updates
    `monthly_case_ids.json`; for any case_id present in a listing but missing
    from canonical, fetches the detail page and merges. Writes a per-run
    reconciliation report. Does NOT refresh existing Pending — Path 1 owns
    that.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    detail_dir = output_dir / "raw" / "details"
    detail_dir.mkdir(parents=True, exist_ok=True)

    canonical_path = output_dir / CANONICAL_CASES_FILE
    canonical: list[dict[str, Any]] = []
    if canonical_path.exists():
        try:
            canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            canonical = []
    canonical_by_number: dict[str, dict[str, Any]] = {
        str(r.get("case_number", "")): r for r in canonical if r.get("case_number")
    }

    months_in_scope = build_months(start_date, end_date)
    log = load_calibration_log(output_dir)
    manifest = load_monthly_manifest(output_dir)

    targets = determine_calibration_targets(end_date, months_in_scope, log)
    skipped = sorted(set(months_in_scope) - set(targets))
    print(
        f"calibrate_targets count={len(targets)} months={targets} "
        f"skipped_already_calibrated={skipped}",
        flush=True,
    )

    today_iso = end_date.isoformat()
    listings_collected: dict[str, list[CaseRecord]] = {}
    for month in targets:
        month_url = f"{BASE_URL}/main.php?dispdate={month}"
        print(f"calibrate_fetch_listing month={month}", flush=True)
        month_html = monthly_fetcher(month_url)
        month_cases = parse_month_page(
            month_html, month=month, start_date=start_date, end_date=end_date
        )
        listings_collected[month] = month_cases
        manifest[month] = sort_case_numbers({c.case_number for c in month_cases})
        log[month] = today_iso
        print(
            f"calibrate_listing_done month={month} "
            f"cases_in_listing={len(month_cases)}",
            flush=True,
        )

    save_monthly_manifest(output_dir, manifest)
    save_calibration_log(output_dir, log)

    # ---- Diff vs canonical → fetch missing details (PoliteHttpClient) ----
    listing_ids: set[str] = set()
    listing_records: dict[str, CaseRecord] = {}
    for cases in listings_collected.values():
        for c in cases:
            listing_ids.add(c.case_number)
            listing_records[c.case_number] = c

    missing = sorted(listing_ids - set(canonical_by_number.keys()), key=lambda v: int(v))
    print(f"calibrate_missing_from_canonical count={len(missing)}", flush=True)

    fetched_missing: list[str] = []
    for case_number in missing:
        try:
            html = fetch_and_cache_detail(case_number, detail_dir, detail_client)
        except FetchError:
            print(f"calibrate_fetch_failed case={case_number}", flush=True)
            continue
        detail = parse_detail_page(html, case_number)
        record = case_from_detail(detail, start_date, end_date)
        if record is None:
            # Fall back to monthly-listing data if detail page can't be parsed.
            record = listing_records[case_number]
        canonical_by_number[case_number] = record.to_dict()
        fetched_missing.append(case_number)

    merged = sorted(
        canonical_by_number.values(),
        key=lambda r: (r.get("check_date", ""), str(r.get("case_number", ""))),
    )
    write_outputs(
        records=None,
        output_dir=output_dir,
        start_date=start_date,
        end_date=end_date,
        merged_records=merged,
    )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "calibrated_months": targets,
        "skipped_already_calibrated_months": skipped,
        "listing_cases_total": len(listing_ids),
        "missing_from_canonical": missing,
        "newly_added_to_canonical": fetched_missing,
        "still_missing": sorted(set(missing) - set(fetched_missing), key=lambda v: int(v)),
    }
    report_dir = output_dir / RECONCILIATION_REPORTS_DIR
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"{end_date.strftime('%Y-%m-%d')}.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"calibrate_report_written path={report_path}", flush=True)
    return report


# =============================================================================
# Output writing
# =============================================================================

def write_outputs(
    records: list[CaseRecord] | None,
    output_dir: Path,
    start_date: date,
    end_date: date,
    *,
    merged_records: list[dict[str, Any]] | None = None,
) -> None:
    """Persist canonical + summary.

    Two calling conventions:
      - `records` only: caller supplies a fresh list; merge with existing
        canonical by case_number (legacy behavior, used by tests).
      - `merged_records` provided: caller has already merged in-memory; just
        persist as-is. Path 1 / Path 2 use this form.
    """
    json_path = output_dir / CANONICAL_CASES_FILE
    summary_path = output_dir / SUMMARY_FILE

    if merged_records is not None:
        dictionaries = list(merged_records)
    else:
        new_dictionaries = [r.to_dict() for r in (records or [])]
        if json_path.exists():
            try:
                existing = json.loads(json_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = []
        else:
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

    json_path.write_text(
        json.dumps(dictionaries, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    summary = {
        **_summary_range(dictionaries, start_date, end_date),
        "case_count": len(dictionaries),
        "detail_count": sum(1 for r in dictionaries if r.get("detail")),
        "note_count": sum(
            1 for r in dictionaries if r.get("detail") and r["detail"].get("Note")
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _summary_range(
    dictionaries: list[dict[str, Any]], start_date: date, end_date: date
) -> dict[str, str]:
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


# =============================================================================
# CLI
# =============================================================================

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Checkee.info scraper: daily refresh + manual calibration.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    daily = sub.add_parser(
        "daily",
        help="Path 1: detail-page refresh (CI). Frontier probe + Pending bucket.",
    )
    daily.add_argument("--start-date", default=DEFAULT_START_DATE.isoformat())
    daily.add_argument("--end-date", default=date.today().isoformat())
    daily.add_argument("--output-dir", default="data/checkee")
    daily.add_argument(
        "--probe-count", type=int, default=80,
        help="Frontier probe size (forward IDs above max_known).",
    )
    daily.add_argument(
        "--bucket", default="auto",
        help="0/1/2 (forces a specific Pending bucket) or 'auto' (from weekday).",
    )
    daily.add_argument(
        "--fetch-budget", type=int, default=1000,
        help="Hard cap on attempts per run (defense against runaway).",
    )
    daily.add_argument("--delay-seconds", type=float, default=3.0)
    daily.add_argument("--jitter-seconds", type=float, default=4.0)
    daily.add_argument("--retries", type=int, default=1)
    daily.add_argument("--timeout", type=int, default=30)
    daily.add_argument("--max-failure-rate", type=float, default=0.20,
                       help="Exit non-zero if failures/attempts exceeds this.")

    calib = sub.add_parser(
        "calibrate",
        help="Path 2: monthly-listing reconciliation (local, headed browser).",
    )
    calib.add_argument("--start-date", default=DEFAULT_START_DATE.isoformat())
    calib.add_argument("--end-date", default=date.today().isoformat())
    calib.add_argument("--output-dir", default="data/checkee")
    calib.add_argument(
        "--headless", action="store_true",
        help="Run browser headless (default is headed so you can watch CF solve).",
    )
    calib.add_argument("--delay-seconds", type=float, default=3.0)
    calib.add_argument("--jitter-seconds", type=float, default=4.0)
    calib.add_argument("--retries", type=int, default=1)
    calib.add_argument("--timeout", type=int, default=30)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    output_dir = Path(args.output_dir)

    if args.command == "daily":
        if args.bucket == "auto":
            beijing_weekday = datetime.now(BEIJING_TZ).weekday()
            bucket = weekday_to_bucket(beijing_weekday)
        else:
            bucket = int(args.bucket)
            if bucket not in (0, 1, 2):
                raise ValueError(f"--bucket must be 0/1/2, got {args.bucket}")

        client = PoliteHttpClient(
            delay_seconds=args.delay_seconds,
            jitter_seconds=args.jitter_seconds,
            retries=args.retries,
            timeout=args.timeout,
        )
        try:
            stats = crawl_daily(
                start_date=start_date,
                end_date=end_date,
                output_dir=output_dir,
                probe_count=args.probe_count,
                bucket=bucket,
                client=client,
                fetch_budget=args.fetch_budget,
            )
        except CircuitBreakerError as error:
            print(f"CIRCUIT_BREAKER {error}", flush=True)
            return 2

        _write_run_summary(output_dir, "daily", stats.to_dict() | {"bucket": bucket})
        if stats.attempts > 0 and stats.failure_rate > args.max_failure_rate:
            print(
                f"failure_rate_exceeded rate={stats.failure_rate:.3f} "
                f"limit={args.max_failure_rate}",
                flush=True,
            )
            return 3
        return 0

    if args.command == "calibrate":
        try:
            from check_trending.cf_fetcher import BrowserFetcher
        except ImportError as error:
            print(
                "patchright not installed. `pip install patchright && "
                "patchright install chromium --no-shell` first.",
                flush=True,
            )
            raise SystemExit(1) from error

        detail_client = PoliteHttpClient(
            delay_seconds=args.delay_seconds,
            jitter_seconds=args.jitter_seconds,
            retries=args.retries,
            timeout=args.timeout,
        )
        with BrowserFetcher(headless=args.headless) as browser:
            report = crawl_calibrate(
                start_date=start_date,
                end_date=end_date,
                output_dir=output_dir,
                monthly_fetcher=browser.fetch,
                detail_client=detail_client,
            )
        _write_run_summary(output_dir, "calibrate", report)
        return 0

    raise ValueError(f"unknown command: {args.command}")


def _write_run_summary(output_dir: Path, command: str, payload: dict[str, Any]) -> None:
    summary = {
        "command": command,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **payload,
    }
    (output_dir / "last_run_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


if __name__ == "__main__":
    sys.exit(main())
