import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


DATA_DIR = Path("data/checkee")
CANONICAL_SOURCE = DATA_DIR / "checkee_cases.json"
SUMMARY = DATA_DIR / "crawl_summary.json"
TARGET = Path("public/data/app-data.json")
NOTES_TARGET = Path("public/data/case-notes.json")

FULL_DATE_RE = re.compile(r"(?<!\d)(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?!\d)")
YEAR_LAST_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](20\d{2})(?!\d)")
COMPACT_DATE_RE = re.compile(r"(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)")
MONTH_DAY_RE = re.compile(r"(?<![\d.])(\d{1,2})[./-](\d{1,2})(?![.\d])")
CHINESE_MONTH_DAY_RE = re.compile(r"(?<!\d)(\d{1,2})月(\d{1,2})日?(?!\d)")
MONTH_NAMES = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "sept": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
MONTH_NAME_PATTERN = r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
DAY_MONTH_NAME_RE = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?[-\s,]+({MONTH_NAME_PATTERN})[-\s,]+(20\d{{2}})\b",
    re.IGNORECASE,
)
MONTH_NAME_DAY_RE = re.compile(
    rf"\b({MONTH_NAME_PATTERN})[-\s,]+(\d{{1,2}})(?:st|nd|rd|th)?(?:[-\s,]+(20\d{{2}}))?\b",
    re.IGNORECASE,
)
NOTE_SIGNAL_PATTERNS = {
    "check_start": re.compile(r"interview|面签|check|221\s*\(?g\)?|221g|long refused|拒签|refused", re.IGNORECASE),
    "security_form": re.compile(r"\bds[- ]?5535\b|5535|10043|\bTAL\b|sensitive|敏感|clearance|background", re.IGNORECASE),
    "materials": re.compile(
        r"补材|补材料|四件套|resume|cv|transcript|study plan|research plan|"
        r"job description|publication|advisor|导师|简历|成绩单|材料",
        re.IGNORECASE,
    ),
    "passport": re.compile(r"护照|passport|return passport|send passport|寄护照", re.IGNORECASE),
    "status_transition": re.compile(
        r"ceac|administrative processing|\bap\b|status|date updated|last updated|状态|更新",
        re.IGNORECASE,
    ),
    "inquiry": re.compile(r"inquiry|email|邮件|催|问询|consulate requested|requested|收到", re.IGNORECASE),
    "escalation": re.compile(
        r"\bWOM\b|mandamus|senator|congress(?:man|woman)?|议员|律师|lawyer|attorney|lawsuit|federal court|起诉|法院",
        re.IGNORECASE,
    ),
    "retry_strategy": re.compile(r"二签|重签|reapply|withdraw|撤签|new case|parallel case|平行case", re.IGNORECASE),
    "outcome": re.compile(
        r"approved|issued|clear(?:ed|ance)?|拒签|rejected|refused under|212\s*\(?a\)?|214b|revoked|visa revoked",
        re.IGNORECASE,
    ),
}
LOW_INCREMENT_RE = re.compile(
    r"模板回复|模版回复|template response|same reply|no update|still refused|still pending|没有更新|依旧标准回复",
    re.IGNORECASE,
)


def resolve_source_file() -> Path:
    if not CANONICAL_SOURCE.exists():
        raise FileNotFoundError(
            f"Missing canonical source file: {CANONICAL_SOURCE}. "
            "Run scripts/sync_dashboard_from_harvest.py first."
        )
    return CANONICAL_SOURCE


def parse_iso_date(value: Any, field_name: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a date string in YYYY-MM-DD format")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise ValueError(f"{field_name} must be a date string in YYYY-MM-DD format") from error


def validate_summary(cases: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    summary_case_count = summary.get("case_count")
    if summary_case_count != len(cases):
        raise ValueError(
            f"summary.case_count={summary_case_count} does not match cases length={len(cases)}"
        )

    summary_start_date = parse_iso_date(summary.get("start_date"), "summary.start_date")
    summary_end_date = parse_iso_date(summary.get("end_date"), "summary.end_date")
    if summary_start_date > summary_end_date:
        raise ValueError("summary.start_date cannot be after summary.end_date")

    for index, record in enumerate(cases):
        check_date = parse_iso_date(record.get("check_date"), f"cases[{index}].check_date")
        if check_date < summary_start_date or check_date > summary_end_date:
            raise ValueError(
                f"cases[{index}].check_date={record.get('check_date')} is outside summary range "
                f"{summary.get('start_date')}..{summary.get('end_date')}"
            )

        complete_date_value = record.get("complete_date")
        if complete_date_value is None:
            continue
        complete_date = parse_iso_date(complete_date_value, f"cases[{index}].complete_date")
        if complete_date > summary_end_date:
            raise ValueError(
                f"cases[{index}].complete_date={complete_date_value} exceeds summary.end_date={summary.get('end_date')}"
            )


def infer_note_activity_date(note: str, check_date_value: str, end_date_value: str) -> str | None:
    dates = note_timeline_dates(note, check_date_value, end_date_value)
    return max(dates).isoformat() if dates else None


def note_timeline_dates(note: str, check_date_value: str, end_date_value: str) -> list[date]:
    check_date = parse_iso_date(check_date_value, "check_date")
    end_date = parse_iso_date(end_date_value, "summary.end_date")
    candidates: set[date] = set()
    earliest = check_date - timedelta(days=45)
    if not note.strip():
        return []

    def add_if_plausible(value: date) -> None:
        if earliest <= value <= end_date:
            candidates.add(value)

    def infer_month_day(month: int, day: int) -> None:
        for year in range(check_date.year, end_date.year + 1):
            try:
                add_if_plausible(date(year, month, day))
            except ValueError:
                continue

    for match in FULL_DATE_RE.finditer(note):
        try:
            value = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            continue
        add_if_plausible(value)

    for match in YEAR_LAST_DATE_RE.finditer(note):
        left = int(match.group(1))
        right = int(match.group(2))
        year = int(match.group(3))
        for month, day in ((left, right), (right, left)):
            try:
                add_if_plausible(date(year, month, day))
            except ValueError:
                continue

    for match in COMPACT_DATE_RE.finditer(note):
        try:
            add_if_plausible(date(int(match.group(1)), int(match.group(2)), int(match.group(3))))
        except ValueError:
            continue

    for match in DAY_MONTH_NAME_RE.finditer(note):
        month = month_name_to_number(match.group(2))
        if month is None:
            continue
        try:
            add_if_plausible(date(int(match.group(3)), month, int(match.group(1))))
        except ValueError:
            continue

    for match in MONTH_NAME_DAY_RE.finditer(note):
        month = month_name_to_number(match.group(1))
        if month is None:
            continue
        day = int(match.group(2))
        year = match.group(3)
        if year:
            try:
                add_if_plausible(date(int(year), month, day))
            except ValueError:
                continue
        else:
            infer_month_day(month, day)

    for match in MONTH_DAY_RE.finditer(note):
        infer_month_day(int(match.group(1)), int(match.group(2)))

    for match in CHINESE_MONTH_DAY_RE.finditer(note):
        infer_month_day(int(match.group(1)), int(match.group(2)))

    return sorted(candidates)


def month_name_to_number(value: str) -> int | None:
    key = value.lower()[:4] if value.lower().startswith("sept") else value.lower()[:3]
    return MONTH_NAMES.get(key)


def note_richness_metrics(note: str, check_date_value: str, end_date_value: str) -> dict[str, int]:
    stripped = note.strip()
    timeline_count = len(note_timeline_dates(stripped, check_date_value, end_date_value))
    matched_signals = {
        name
        for name, pattern in NOTE_SIGNAL_PATTERNS.items()
        if pattern.search(stripped)
    }
    signal_count = len(matched_signals)
    note_length = len(stripped)
    length_score = (1 if note_length >= 80 else 0) + (1 if note_length >= 220 else 0)
    timeline_score = 0
    if timeline_count >= 5:
        timeline_score = 3
    elif timeline_count >= 3:
        timeline_score = 2
    elif timeline_count >= 1:
        timeline_score = 1
    signal_weights = {
        "check_start": 1,
        "security_form": 2,
        "materials": 2,
        "passport": 2,
        "status_transition": 1,
        "inquiry": 1,
        "escalation": 2,
        "retry_strategy": 2,
        "outcome": 3,
    }
    score = length_score + timeline_score + sum(signal_weights[name] for name in matched_signals)
    if LOW_INCREMENT_RE.search(stripped) and not ({"outcome", "passport", "escalation", "retry_strategy"} & matched_signals):
        score -= 1
    if infer_note_activity_date(stripped, check_date_value, end_date_value):
        score += 1
    score = max(0, score)
    return {
        "note_timeline_count": timeline_count,
        "note_signal_count": signal_count,
        "note_richness_score": score,
    }


def to_public_case(record: dict, summary_end_date: str) -> dict:
    # Note + detail_url are intentionally excluded: the dashboard analytics never use them,
    # and the Note text is ~80% of the payload. detail_url is reconstructed client-side from
    # case_number; Notes ship in case-notes.json, lazy-loaded only for the sample table.
    detail = record.get("detail") or {}
    note = (detail.get("Note") or "").strip()
    note_updated_at = detail.get("Note Updated At") or infer_note_activity_date(
        note,
        record["check_date"],
        summary_end_date,
    )
    note_metrics = note_richness_metrics(note, record["check_date"], summary_end_date)
    return {
        "case_number": record["case_number"],
        "check_date": record["check_date"],
        "complete_date": record["complete_date"],
        "consulate": record["consulate"],
        "has_note": bool(note),
        **note_metrics,
        "note_updated_at": note_updated_at,
        "status": record["status"],
        "visa_type": record["visa_type"],
        "waiting_days": record["waiting_days"],
    }


def main() -> None:
    source = resolve_source_file()
    cases = json.loads(source.read_text(encoding="utf-8"))
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    validate_summary(cases, summary)
    public_cases = [to_public_case(record, summary["end_date"]) for record in cases]
    case_notes = {
        record["case_number"]: (record.get("detail") or {}).get("Note", "")
        for record in cases
        if (record.get("detail") or {}).get("Note")
    }
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        json.dumps({"cases": public_cases, "summary": summary}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    NOTES_TARGET.write_text(
        json.dumps(case_notes, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {TARGET} ({len(public_cases)} cases) + {NOTES_TARGET} ({len(case_notes)} notes) from {source}")


if __name__ == "__main__":
    main()
