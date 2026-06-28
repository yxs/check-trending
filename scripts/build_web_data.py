import json
from datetime import date, datetime
from pathlib import Path
from typing import Any


DATA_DIR = Path("data/checkee")
CANONICAL_SOURCE = DATA_DIR / "checkee_cases.json"
SUMMARY = DATA_DIR / "crawl_summary.json"
TARGET = Path("public/data/app-data.json")


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


def to_public_case(record: dict) -> dict:
    detail = record.get("detail") or {}
    return {
        "case_number": record["case_number"],
        "check_date": record["check_date"],
        "complete_date": record["complete_date"],
        "consulate": record["consulate"],
        "detail": {"Note": detail.get("Note", "")},
        "detail_url": record["detail_url"],
        "display_id": record["display_id"],
        "major": record["major"],
        "month": record["month"],
        "status": record["status"],
        "visa_entry": record["visa_entry"],
        "visa_type": record["visa_type"],
        "waiting_days": record["waiting_days"],
    }


def main() -> None:
    source = resolve_source_file()
    cases = json.loads(source.read_text(encoding="utf-8"))
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    validate_summary(cases, summary)
    public_cases = [to_public_case(record) for record in cases]
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        json.dumps({"cases": public_cases, "summary": summary}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {TARGET} from {source} with {len(public_cases)} cases")


if __name__ == "__main__":
    main()
