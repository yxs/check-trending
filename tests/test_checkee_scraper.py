import unittest
from datetime import date

from check_trending.checkee_scraper import (
    build_months,
    case_from_detail,
    parse_detail_page,
    parse_month_page,
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


if __name__ == "__main__":
    unittest.main()
