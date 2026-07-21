#!/usr/bin/env python3
"""Build public/data/notes.json from legacy harvest snapshots plus canonical data."""
import glob
import gzip
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CANONICAL_SOURCE = Path("data/checkee/checkee_cases.json")
SUMMARY_SOURCE = Path("data/checkee/crawl_summary.json")
TARGET = Path("public/data/notes.json")


def shared_window(dates: list[str]) -> tuple[str, str]:
    """Display range shared with the dashboard: prefer crawl_summary.json so both
    pages show the same window; fall back to the corpus min/max if it is absent."""
    if SUMMARY_SOURCE.exists():
        try:
            summary = json.loads(SUMMARY_SOURCE.read_text(encoding="utf-8"))
            return summary["start_date"], summary["end_date"]
        except (json.JSONDecodeError, KeyError):
            pass
    return min(dates), max(dates)


def note_record_from_harvest(record: dict[str, Any]) -> dict[str, Any] | None:
    note = (record.get("note") or "").strip()
    if not note:
        return None
    complete_date = record.get("cmp") or ""
    try:
        waiting_days = int(record.get("wd"))
    except (TypeError, ValueError):
        waiting_days = None
    return {
        "cn": str(record.get("cn", "")),
        "vt": record.get("vt", ""),
        "ve": record.get("ve", ""),
        "co": record.get("con", ""),
        "mj": record.get("maj", ""),
        "st": record.get("st", ""),
        "cd": record.get("cd", ""),
        "cp": None if complete_date in ("", "0000-00-00") else complete_date,
        "wd": waiting_days,
        "nt": note,
    }


def note_record_from_canonical(record: dict[str, Any]) -> dict[str, Any] | None:
    note = ((record.get("detail") or {}).get("Note") or "").strip()
    if not note:
        return None
    return {
        "cn": str(record.get("case_number", "")),
        "vt": record.get("visa_type", ""),
        "ve": record.get("visa_entry", ""),
        "co": record.get("consulate", ""),
        "mj": record.get("major", ""),
        "st": record.get("status", ""),
        "cd": record.get("check_date", ""),
        "cp": record.get("complete_date"),
        "wd": record.get("waiting_days"),
        "nt": note,
    }


def build_notes_cases() -> list[dict[str, Any]]:
    by_case: dict[str, dict[str, Any]] = {}

    for path in sorted(glob.glob("_harvest_*.json")):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for raw_record in data["records"]:
            record = note_record_from_harvest(raw_record)
            if record is None:
                continue
            prev = by_case.get(record["cn"])
            if prev is None or len(record["nt"]) > len(prev["nt"]):
                by_case[record["cn"]] = record

    if CANONICAL_SOURCE.exists():
        canonical = json.loads(CANONICAL_SOURCE.read_text(encoding="utf-8"))
        for raw_record in canonical:
            record = note_record_from_canonical(raw_record)
            if record is not None:
                by_case[record["cn"]] = record

    cases = list(by_case.values())
    cases.sort(key=lambda item: (item["cd"], item["cn"]), reverse=True)
    return cases


def main() -> None:
    cases = build_notes_cases()
    dates = [record["cd"] for record in cases if record["cd"]]
    start_date, end_date = shared_window(dates)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(cases),
        "start_date": start_date,
        "end_date": end_date,
        "cases": cases,
    }
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    TARGET.write_text(blob, encoding="utf-8")

    raw = len(blob.encode("utf-8"))
    gz = len(gzip.compress(blob.encode("utf-8")))
    note_lengths = sorted(len(record["nt"]) for record in cases)

    def pct(p: float) -> int:
        return note_lengths[min(len(note_lengths) - 1, int(len(note_lengths) * p))]

    print(f"wrote {TARGET}")
    print(f"cases: {len(cases)}  range: {payload['start_date']} .. {payload['end_date']}")
    print(f"size: raw={raw / 1e6:.2f} MB  gzip={gz / 1e6:.2f} MB")
    print(f"note length: p50={pct(.5)} p90={pct(.9)} p99={pct(.99)} max={note_lengths[-1]}")
    print("status mix:", dict(Counter(record["st"] for record in cases).most_common(6)))
    print("visa mix:", dict(Counter(record["vt"] for record in cases).most_common(8)))


if __name__ == "__main__":
    main()
