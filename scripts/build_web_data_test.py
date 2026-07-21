import unittest

from build_notes_corpus import note_record_from_canonical, note_record_from_harvest


class NotesCorpusRecordTest(unittest.TestCase):
    def test_canonical_record_maps_to_notes_search_shape(self) -> None:
        record = note_record_from_canonical({
            "case_number": "123",
            "visa_type": "H1",
            "visa_entry": "New",
            "consulate": "ShangHai",
            "major": "CS",
            "status": "Clear",
            "check_date": "2026-01-02",
            "complete_date": "2026-07-04",
            "waiting_days": 183,
            "detail": {"Note": "latest canonical note"},
        })

        self.assertEqual(record, {
            "cn": "123",
            "vt": "H1",
            "ve": "New",
            "co": "ShangHai",
            "mj": "CS",
            "st": "Clear",
            "cd": "2026-01-02",
            "cp": "2026-07-04",
            "wd": 183,
            "nt": "latest canonical note",
        })

    def test_harvest_record_normalizes_empty_complete_date(self) -> None:
        record = note_record_from_harvest({
            "cn": "123",
            "vt": "F1",
            "ve": "Renewal",
            "con": "BeiJing",
            "maj": "Physics",
            "st": "Pending",
            "cd": "2026-01-02",
            "cmp": "0000-00-00",
            "wd": "20",
            "note": "legacy note",
        })

        self.assertEqual(record["cp"], None)
        self.assertEqual(record["wd"], 20)


if __name__ == "__main__":
    unittest.main()
