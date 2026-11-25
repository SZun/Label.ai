"""A failed social post must not hide results from the other required platforms."""
from contextlib import redirect_stdout
from io import StringIO
import importlib.util
from pathlib import Path
import unittest


def load_batch():
    path = Path(__file__).resolve().parents[1] / "e2e" / "social_batch.py"
    spec = importlib.util.spec_from_file_location("social_batch", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SocialBatchTest(unittest.TestCase):
    def test_all_five_run_including_after_a_failure(self):
        batch = load_batch()
        seen = []

        def check(platform):
            seen.append(platform)
            if platform in {"tiktok", "instagram"}:
                raise RuntimeError("unable to confirm playback")

        with redirect_stdout(StringIO()) as log:
            result = batch.check_platforms(check)
        self.assertIn("instagram: FAIL", log.getvalue())
        self.assertEqual(seen, ["youtube", "tiktok", "facebook", "instagram", "x"])
        self.assertEqual(result, {"youtube": True, "tiktok": False, "facebook": True,
                                  "instagram": False, "x": True})
        with redirect_stdout(StringIO()):
            self.assertTrue(all(batch.check_platforms(lambda site: None).values()))
