import json
import re
from pathlib import Path


DATA_DIR = Path("data/checkee")
SUMMARY = Path("data/checkee/crawl_summary.json")
TARGET = Path("public/data/app-data.json")
DATA_FILE_PATTERN = re.compile(r"checkee_cases_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.json$")


def find_latest_source() -> Path:
    candidates = [path for path in DATA_DIR.glob("checkee_cases_*_to_*.json") if DATA_FILE_PATTERN.match(path.name)]
    if not candidates:
        raise FileNotFoundError("No normalized Checkee JSON file found in data/checkee")
    return max(candidates, key=lambda path: path.stat().st_mtime)


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
    source = find_latest_source()
    cases = json.loads(source.read_text(encoding="utf-8"))
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    public_cases = [to_public_case(record) for record in cases]
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        json.dumps({"cases": public_cases, "summary": summary}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {TARGET} from {source} with {len(public_cases)} cases")


if __name__ == "__main__":
    main()
