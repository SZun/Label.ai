import unittest
from tools.build_apple_host import select_scheme

class SchemeTests(unittest.TestCase):
    def test_distinct_app_schemes(self):
        names = ["Label AI (macOS)", "Label AI (iOS)", "Label AI Extension (iOS)"]
        self.assertEqual(select_scheme(names, "iOS"), "Label AI (iOS)")
    def test_shared_multiplatform_app(self):
        self.assertEqual(select_scheme(["Label AI", "Label AI Extension"], "macOS"), "Label AI")
    def test_ambiguous_schemes_require_inspection(self):
        with self.assertRaises(ValueError):
            select_scheme(["Label AI", "Helper"], "iOS")
