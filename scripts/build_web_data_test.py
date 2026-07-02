import unittest

from build_web_data import infer_note_activity_date, note_richness_metrics


class InferNoteActivityDateTest(unittest.TestCase):
    def test_infers_recent_month_day_entries_after_check_date(self) -> None:
        note = """Mexico, Guadalajara

2025.12.05, ASC Fingerprint, photo
2025.12.09, interview -> refused
2026.01.07, CEAC status updated
2026.01.26, Consulate requested transcripts

03.06 为什么，为什么我还不过
03.13 why? 下周就是 100天了
"""

        self.assertEqual(
            infer_note_activity_date(note, "2025-12-09", "2026-06-28"),
            "2026-03-13",
        )

    def test_returns_none_when_note_has_no_parseable_dates(self) -> None:
        self.assertIsNone(infer_note_activity_date("still waiting", "2025-12-09", "2026-06-28"))

    def test_scores_timeline_and_process_signals(self) -> None:
        metrics = note_richness_metrics(
            """2025.12.09 interview -> refused, 221g, ds5535
2026.01.26 Consulate requested transcripts, job description, and resume
03.13 still waiting after CEAC status update
""",
            "2025-12-09",
            "2026-06-28",
        )

        self.assertGreaterEqual(metrics["note_timeline_count"], 3)
        self.assertGreaterEqual(metrics["note_signal_count"], 4)
        self.assertGreaterEqual(metrics["note_richness_score"], 8)

    def test_understands_common_date_formats_from_real_notes(self) -> None:
        note = """20250508 interview, checked, long refused
Dec-10-2024 面签，广州
8月20：check，给了221G补材料
Sep 20, case created
"""

        metrics = note_richness_metrics(note, "2024-08-20", "2026-06-28")

        self.assertGreaterEqual(metrics["note_timeline_count"], 4)

    def test_rewards_actionable_resolution_over_repeated_no_update(self) -> None:
        actionable = note_richness_metrics(
            """10.06.2025 221(g)
20.12.2025 filed mandamus
13.02.2026 clearance received
18.02.2026 visa issued
""",
            "2025-10-06",
            "2026-06-28",
        )
        repeated = note_richness_metrics(
            """12/16 check
1/16 no update, template response
2/16 no update, template response
3/16 no update, template response
4/16 no update, template response
""",
            "2025-12-16",
            "2026-06-28",
        )

        self.assertGreater(actionable["note_richness_score"], repeated["note_richness_score"])


if __name__ == "__main__":
    unittest.main()
