#!/usr/bin/env python3
"""Rebuild the canonical dataset from browser-fetched Checkee HTML.

WHY THIS EXISTS
---------------
Both Checkee endpoints are now behind a Cloudflare *managed JS challenge*:

    https://www.checkee.info/main.php?dispdate=YYYY-MM     (monthly listings)
    https://www.checkee.info/personal_detail.php?casenum=  (case detail)

`curl_cffi` (any TLS-impersonation profile, any residential IP) gets a 403
"Just a moment" page from both — so the old automated paths (the launchd daily
cron and calibrate's urllib detail fetch) no longer work. The only thing that
works is a *real browser* where a human clicks through the challenge once;
after that, same-origin `fetch()` calls reuse the cleared session cookies and
return 200.

Refresh is therefore a two-step manual chore (run monthly, or whenever):

  1. BROWSER (interactive — see README "数据更新"): open checkee.info, solve the
     Cloudflare challenge, then fetch every month listing + each genuinely-new
     case's detail page through the cleared session, saving raw HTML under:
         data/checkee/raw/refresh/listings/<YYYY-MM>.html
         data/checkee/raw/refresh/details/<casenum>.html

  2. THIS SCRIPT (offline, no network): parse that HTML, reconcile it against
     the canonical dataset, and regenerate the data files + frontend payload.

RECONCILIATION RULES
--------------------
  * Every case in a fetched listing has its status / dates / waiting_days
    overwritten from the listing — this is what catches Pending -> Clear flips
    (the job the dead daily cron used to do).
  * A case present in a listing but absent from canonical is a NEW case; its
    Note comes from a matching detail HTML file if one was fetched.
  * An existing case keeps its cached Note unless a fresh detail page is given.
  * A canonical case that appears in no fetched listing is retained unchanged.

USAGE
-----
    python scripts/refresh_from_browser.py
    python scripts/refresh_from_browser.py --refresh-dir data/checkee/raw/refresh

Run from the repository root. Refuses to touch the dataset if no listings are
found (so an empty/incorrect dir can't silently wipe data).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))  # allow `import check_trending` when run as a script

from check_trending.checkee_scraper import parse_detail_page, parse_month_page  # noqa: E402
DATA_DIR = REPO_ROOT / "data" / "checkee"
CANONICAL = DATA_DIR / "checkee_cases.json"
SUMMARY = DATA_DIR / "crawl_summary.json"
START_DATE = date(2025, 7, 1)


def _max_date(values) -> str:
    real = [v for v in values if v and v != "0000-00-00"]
    return max(real) if real else START_DATE.isoformat()


def load_listings(listings_dir: Path) -> dict[str, dict]:
    """Parse every <YYYY-MM>.html listing into {case_number: record_dict}."""
    fresh: dict[str, dict] = {}
    today = date.today()
    files = sorted(listings_dir.glob("*.html"))
    for path in files:
        month = path.stem  # YYYY-MM
        html = path.read_text(encoding="utf-8")
        records = parse_month_page(html, month=month, start_date=START_DATE, end_date=today)
        for rec in records:
            fresh[rec.case_number] = rec.to_dict()
        print(f"  listing {month}: {len(records)} cases")
    return fresh


def load_details(details_dir: Path) -> dict[str, dict]:
    """Parse every <casenum>.html detail page into {case_number: detail_dict}."""
    details: dict[str, dict] = {}
    if not details_dir.exists():
        return details
    for path in sorted(details_dir.glob("*.html")):
        case_number = path.stem
        details[case_number] = parse_detail_page(path.read_text(encoding="utf-8"), case_number)
    return details


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh-dir",
        default=str(DATA_DIR / "raw" / "refresh"),
        help="Directory holding listings/<month>.html and details/<casenum>.html",
    )
    args = parser.parse_args()
    refresh_dir = Path(args.refresh_dir)
    listings_dir = refresh_dir / "listings"
    details_dir = refresh_dir / "details"

    if not listings_dir.exists() or not any(listings_dir.glob("*.html")):
        print(
            f"No listings found in {listings_dir}. Fetch the month pages through a "
            f"browser first (see README 数据更新). Refusing to touch the dataset.",
            file=sys.stderr,
        )
        return 1

    print("parsing browser-fetched HTML...")
    fresh = load_listings(listings_dir)
    details = load_details(details_dir)
    print(f"  fetched details: {len(details)}")

    canonical = json.loads(CANONICAL.read_text(encoding="utf-8"))
    merged = {str(r["case_number"]): dict(r) for r in canonical}  # keep cached Note + non-listed cases

    new_cases = 0
    flips = 0
    for cid, frec in fresh.items():
        prev = merged.get(cid)
        record = dict(frec)
        if prev is not None:
            record["detail"] = prev.get("detail")  # preserve cached Note
            if prev.get("status") != record.get("status"):
                flips += 1
        else:
            new_cases += 1
        if cid in details:  # a freshly fetched detail page wins (fills Note for new cases)
            record["detail"] = details[cid]
        merged[cid] = record

    ordered = [merged[c] for c in sorted(merged, key=lambda v: int(v))]
    end_date = max(
        _max_date(r["check_date"] for r in ordered),
        _max_date(r.get("complete_date") for r in ordered),
        date.today().isoformat(),
    )
    note_count = sum(1 for r in ordered if (r.get("detail") or {}).get("Note", "").strip())
    summary = {
        "case_count": len(ordered),
        "detail_count": sum(1 for r in ordered if r.get("detail")),
        "end_date": end_date,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note_count": note_count,
        "start_date": START_DATE.isoformat(),
    }

    CANONICAL.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding="utf-8")
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"merged: {len(ordered)} cases (+{new_cases} new, {flips} status flips, "
        f"{note_count} with Note, through {end_date})"
    )

    print("building public/data/app-data.json...")
    subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "build_web_data.py")], cwd=REPO_ROOT, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
