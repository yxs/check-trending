import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from check_trending.checkee_scraper import (
    CaseRecord,
    build_months,
    case_from_detail,
    determine_fetch_required_months,
    extract_detail_table_html,
    load_monthly_manifest,
    parse_detail_page,
    parse_month_page,
    previous_month_label,
    save_monthly_manifest,
    write_outputs,
)


MONTH_HTML = """
<html>
  <body>
    <table>
      <tr>
        <th>Update</th><th>ID</th><th>Visa Type</th><th>Visa Entry</th>
        <th>US Consulate</th><th>Major</th><th>Status</th>
        <th>Check Date</th><th>Complete Date</th><th>Waiting Day(s)</th><th>Details</th>
      </tr>
      <tr>
        <td><a href="update.php?casenum=843418">Update</a></td>
        <td>icecream_melted</td>
        <td>L1</td>
        <td>New</td>
        <td>Vancouver</td>
        <td>Computer Science</td>
        <td>Clear</td>
        <td>2025-08-01</td>
        <td>2025-08-07</td>
        <td>6</td>
        <td><a href="personal_detail.php?casenum=843418">detail</a></td>
      </tr>
      <tr>
        <td><a href="update.php?casenum=843510">Update</a></td>
        <td>求求求下签</td>
        <td>F1</td>
        <td>Renewal</td>
        <td>ShangHai</td>
        <td>robo</td>
        <td>Pending</td>
        <td>2025-08-01</td>
        <td>0000-00-00</td>
        <td>235</td>
        <td><a href="http://www.checkee.info/personal_detail.php?casenum=843510">detail</a></td>
      </tr>
    </table>
  </body>
</html>
"""


DETAIL_HTML = """
<html>
  <body>
    <table>
      <tr><td>Checkee CaseNum: 843475</td><td>Last Name: N/A</td></tr>
      <tr><td>ID: APAP</td><td>First Name: N/A</td></tr>
      <tr><td>Check Date: 2025-08-12</td><td>University(College): N/A</td></tr>
      <tr><td>Visa Type: B1</td><td>Degree: MS</td></tr>
      <tr><td>Visa Entry: New</td><td>Employer: N/A</td></tr>
      <tr><td>US Consulate: Europe</td><td>Job Title: N/A</td></tr>
      <tr><td>Major: Computer Science</td><td>Years in Usa: 6</td></tr>
      <tr><td>Status: Clear</td><td>Country: N/A</td></tr>
      <tr><td>Complete Date: 2026-03-05</td></tr>
      <tr><td>Note: London Embassy. Case Created: 08-Aug-2025 Issued: 05-Mar-2026</td></tr>
    </table>
  </body>
</html>
"""


def _detail_table_fixture() -> str:
    """Build the detail-table HTML used by extract_detail_table_html.

    The literal table tag is split via concatenation so neither this file nor
    the scraper module contains the trim sentinel as a single contiguous
    substring (a guard against blob-callback tools accidentally treating the
    source as a detail page during history rewrites).
    """
    table_open = '<' + 'table width="96%" border="1" align="center" cellspacing="0">'
    table_close = '<' + '/table>'
    return f"""
        <html><body>
        <table><tr><td>header</td></tr></table>
        {table_open}
          <tr><td>Checkee CaseNum: 843475</td></tr>
          <tr><td>Note: demo note</td></tr>
        {table_close}
        <script>console.log("noise")</script>
        </body></html>
        """


class CheckeeScraperTest(unittest.TestCase):
    def test_build_months_includes_start_and_end_month(self) -> None:
        self.assertEqual(
            build_months(date(2025, 7, 1), date(2026, 4, 29)),
            [
                "2025-07",
                "2025-08",
                "2025-09",
                "2025-10",
                "2025-11",
                "2025-12",
                "2026-01",
                "2026-02",
                "2026-03",
                "2026-04",
            ],
        )

    def test_parse_month_page_extracts_cases_with_case_numbers_and_details(self) -> None:
        cases = parse_month_page(MONTH_HTML, month="2025-08", start_date=date(2025, 7, 1))

        self.assertEqual(len(cases), 2)
        self.assertEqual(cases[0].case_number, "843418")
        self.assertEqual(cases[0].display_id, "icecream_melted")
        self.assertEqual(cases[0].visa_type, "L1")
        self.assertEqual(cases[0].consulate, "Vancouver")
        self.assertEqual(cases[0].status, "Clear")
        self.assertEqual(cases[0].check_date, "2025-08-01")
        self.assertEqual(cases[0].complete_date, "2025-08-07")
        self.assertEqual(cases[0].waiting_days, 6)
        self.assertEqual(
            cases[0].detail_url,
            "https://www.checkee.info/personal_detail.php?casenum=843418",
        )
        self.assertEqual(cases[1].complete_date, None)

    def test_parse_month_page_skips_cases_before_start_date(self) -> None:
        old_case_html = MONTH_HTML.replace("2025-08-01", "2025-06-30")

        cases = parse_month_page(old_case_html, month="2025-06", start_date=date(2025, 7, 1))

        self.assertEqual(cases, [])

    def test_parse_month_page_respects_end_date(self) -> None:
        cases = parse_month_page(
            MONTH_HTML,
            month="2025-08",
            start_date=date(2025, 7, 1),
            end_date=date(2025, 7, 31),
        )

        self.assertEqual(cases, [])

    def test_parse_detail_page_extracts_all_fields_and_note(self) -> None:
        detail = parse_detail_page(DETAIL_HTML, "843475")

        self.assertEqual(detail["case_number"], "843475")
        self.assertEqual(detail["ID"], "APAP")
        self.assertEqual(detail["Degree"], "MS")
        self.assertEqual(detail["Years in Usa"], "6")
        self.assertEqual(
            detail["Note"],
            "London Embassy. Case Created: 08-Aug-2025 Issued: 05-Mar-2026",
        )

    def test_parse_detail_page_ignores_pageview_script_fields(self) -> None:
        html = DETAIL_HTML.replace(
            "</table>",
            "</table><table><tr><td>var scJsHost = ((\"https:\" == document.location.protocol) ? \"https://secure.\" : \"http://www.\"); Pageviews</td></tr></table>",
            1,
        )

        detail = parse_detail_page(html, "843475")

        self.assertNotIn(
            "var scJsHost = ((\"https",
            detail,
        )

    def test_extract_detail_table_html_keeps_only_detail_table(self) -> None:
        extracted = extract_detail_table_html(_detail_table_fixture())

        self.assertIsNotNone(extracted)
        assert extracted is not None
        self.assertIn("Checkee CaseNum: 843475", extracted)
        self.assertNotIn("<script>", extracted)

    def test_case_from_detail_filters_by_check_date_and_preserves_note(self) -> None:
        detail = parse_detail_page(DETAIL_HTML, "843475")

        record = case_from_detail(detail, start_date=date(2025, 7, 1), end_date=date(2026, 4, 29))

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.case_number, "843475")
        self.assertEqual(record.month, "2025-08")
        self.assertEqual(record.waiting_days, 205)
        self.assertEqual(record.detail["Note"], detail["Note"])

    def test_case_from_detail_skips_cases_outside_requested_range(self) -> None:
        detail = parse_detail_page(DETAIL_HTML.replace("2025-08-12", "2025-06-30"), "843475")

        record = case_from_detail(detail, start_date=date(2025, 7, 1), end_date=date(2026, 4, 29))

        self.assertIsNone(record)

    def test_previous_month_label_handles_year_boundary(self) -> None:
        self.assertEqual(previous_month_label("2026-01"), "2025-12")
        self.assertEqual(previous_month_label("2026-05"), "2026-04")

    def test_determine_fetch_required_includes_buffer_within_15(self) -> None:
        months = ["2025-07", "2025-08", "2026-04", "2026-05"]
        manifest = {month: ["1"] for month in months}

        required_early = determine_fetch_required_months(
            end_date=date(2026, 5, 10), months=months, manifest=manifest
        )
        self.assertEqual(required_early, {"2026-04", "2026-05"})

        required_late = determine_fetch_required_months(
            end_date=date(2026, 5, 20), months=months, manifest=manifest
        )
        self.assertEqual(required_late, {"2026-05"})

    def test_determine_fetch_required_pulls_in_months_missing_from_manifest(self) -> None:
        months = ["2025-07", "2025-08", "2025-09", "2026-05"]
        manifest = {"2025-07": ["1"], "2026-05": ["2"]}

        required = determine_fetch_required_months(
            end_date=date(2026, 5, 20), months=months, manifest=manifest
        )

        self.assertEqual(required, {"2025-08", "2025-09", "2026-05"})

    def test_determine_fetch_required_force_all_overrides(self) -> None:
        months = ["2025-07", "2025-08", "2026-05"]
        manifest = {month: ["1"] for month in months}

        required = determine_fetch_required_months(
            end_date=date(2026, 5, 20),
            months=months,
            manifest=manifest,
            force_all=True,
        )

        self.assertEqual(required, set(months))

    def test_monthly_manifest_round_trips_and_sorts_case_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            manifest = {
                "2025-08": ["100", "10", "1"],
                "2025-07": ["20", "2"],
            }

            save_monthly_manifest(output_dir, manifest)
            roundtripped = load_monthly_manifest(output_dir)

            self.assertEqual(
                roundtripped,
                {"2025-07": ["2", "20"], "2025-08": ["1", "10", "100"]},
            )

    def test_write_outputs_merges_with_existing_canonical_by_case_number(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            existing = [
                {
                    "case_number": "100",
                    "check_date": "2025-07-15",
                    "complete_date": "2025-07-25",
                    "status": "Clear",
                    "month": "2025-07",
                    "detail": {"Note": "stale"},
                    "display_id": "old",
                    "visa_type": "B1",
                    "visa_entry": "New",
                    "consulate": "Vancouver",
                    "major": "CS",
                    "waiting_days": 10,
                    "detail_url": "https://www.checkee.info/personal_detail.php?casenum=100",
                    "source_url": "https://www.checkee.info/personal_detail.php?casenum=100",
                },
                {
                    "case_number": "200",
                    "check_date": "2025-08-01",
                    "complete_date": None,
                    "status": "Pending",
                    "month": "2025-08",
                    "detail": {"Note": ""},
                    "display_id": "kept",
                    "visa_type": "F1",
                    "visa_entry": "New",
                    "consulate": "Beijing",
                    "major": "EE",
                    "waiting_days": 30,
                    "detail_url": "https://www.checkee.info/personal_detail.php?casenum=200",
                    "source_url": "https://www.checkee.info/personal_detail.php?casenum=200",
                },
            ]
            (output_dir / "checkee_cases.json").write_text(
                json.dumps(existing, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            updated = CaseRecord(
                case_number="100",
                display_id="new",
                visa_type="B1",
                visa_entry="New",
                consulate="Vancouver",
                major="CS",
                status="Clear",
                check_date="2025-07-15",
                complete_date="2025-07-25",
                waiting_days=10,
                detail_url="https://www.checkee.info/personal_detail.php?casenum=100",
                month="2025-07",
                source_url="https://www.checkee.info/personal_detail.php?casenum=100",
                detail={"Note": "fresh"},
            )
            new_case = CaseRecord(
                case_number="300",
                display_id="brand_new",
                visa_type="H1B",
                visa_entry="Renewal",
                consulate="ShangHai",
                major="ME",
                status="Pending",
                check_date="2025-09-10",
                complete_date=None,
                waiting_days=20,
                detail_url="https://www.checkee.info/personal_detail.php?casenum=300",
                month="2025-09",
                source_url="https://www.checkee.info/personal_detail.php?casenum=300",
                detail={"Note": ""},
            )

            write_outputs(
                [updated, new_case],
                output_dir,
                start_date=date(2025, 7, 1),
                end_date=date(2025, 9, 30),
                merge_with_canonical=True,
            )

            merged = json.loads((output_dir / "checkee_cases.json").read_text(encoding="utf-8"))
            by_number = {record["case_number"]: record for record in merged}

            self.assertEqual(set(by_number.keys()), {"100", "200", "300"})
            self.assertEqual(by_number["100"]["detail"]["Note"], "fresh")
            self.assertEqual(by_number["100"]["display_id"], "new")
            self.assertEqual(by_number["200"]["display_id"], "kept")
            self.assertEqual(by_number["300"]["status"], "Pending")

            summary = json.loads((output_dir / "crawl_summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["case_count"], 3)
            self.assertEqual(summary["start_date"], "2025-07-01")
            # End-date must extend to cover observed complete_date.
            self.assertGreaterEqual(summary["end_date"], "2025-09-30")


if __name__ == "__main__":
    unittest.main()
