import runpy
import unittest
from pathlib import Path


class SamplingTest(unittest.TestCase):
    def test_browser_fixture_uses_all_three_parts_of_longer_short_clip(self):
        sample = runpy.run_path(str(Path(__file__).with_name("prepare-smoke.py")))["browser_timestamps"]
        times = sample(20)
        self.assertEqual(len(times), 12)
        self.assertAlmostEqual(times[3] - times[0], 4.2)
        self.assertGreater(times[-1], 18)
        self.assertLess(times[-1], 20)
        with self.assertRaises(ValueError):
            sample(23)
