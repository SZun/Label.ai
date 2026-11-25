import unittest
from collections import Counter
from unittest.mock import patch

from tools import evaluate_browsing_sensitivity as benchmark


class SensitivitySelectionTest(unittest.TestCase):
    def test_selection_is_order_independent_and_separates_source_groups(self):
        rows = []

        def add(group, label, author, source, generator=""):
            for variant in ("original", "instagram"):
                rows.append(dict(id=group, media="image", variant=variant, label=label,
                                 author=author, source_url=source, generator=generator))

        for family in range(19):
            for index in range(4):
                add(f"generated-{family}-{index}", "ai", "publisher", "", str(family))
        for index in range(130):
            # Overlapping photographers and source URLs also occur across distinct IDs.
            add(f"real-{index}", "real", f"author-{index % 100}", f"source-{index % 95}")
        prior = [rows[0], rows[-1]]
        with patch.object(benchmark.frontier, "select", return_value=prior):
            originals, social = benchmark.select(rows)
            self.assertEqual((originals, social), benchmark.select(list(reversed(rows))))
        self.assertEqual(len(originals), 114)
        ids = {r["id"] for r in originals}
        self.assertEqual(len(ids), 114)
        self.assertTrue(ids.isdisjoint({r["id"] for r in prior}))
        generated = [r for r in originals if r["label"] == "ai"]
        self.assertEqual(Counter(r["generator"] for r in generated),
                         {str(family): 3 for family in range(19)})
        genuine = [r for r in originals if r["label"] == "real"]
        for field in ("author", "source_url"):
            values = {r[field] for r in genuine}
            self.assertEqual(len(values), 57)
            self.assertNotIn(prior[-1][field], values)
        self.assertEqual(len(social), 38)
        self.assertTrue({r["id"] for r in social}.issubset(ids))
        self.assertEqual(Counter(r["label"] for r in social), {"real": 19, "ai": 19})

    def test_zero_observed_errors_still_has_a_positive_upper_bound(self):
        result = benchmark.rate(0, 57)
        self.assertEqual(result["rate"], 0.0)
        self.assertEqual(result["wilson95"], [0.0, 0.0631])
