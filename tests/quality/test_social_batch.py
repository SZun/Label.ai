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

    def test_login_stays_in_platform_window_and_is_optional(self):
        batch = load_batch()
        events = []

        class Page:
            def goto(self, url, **options):
                events.append(url)

        target = "https://www.instagram.com/reel/sample/"
        confirm = lambda message: events.append("operator-ready")
        batch.open_public_post(Page(), "instagram", target, True, confirm)
        self.assertEqual(events, ["https://www.instagram.com/", "operator-ready", target])
        events.clear()
        batch.open_public_post(Page(), "instagram", target, False, confirm)
        self.assertEqual(events, [target])

    def test_local_report_binds_all_five_to_the_loaded_build_and_retains_misses(self):
        import json
        from tempfile import TemporaryDirectory
        batch = load_batch()
        results = {site: site == "youtube" for site in batch.REQUIRED_PLATFORMS}
        with TemporaryDirectory() as work:
            folder = Path(work)
            build = folder / "extension"
            build.mkdir()
            (build / "manifest.json").write_text('{"version":"0.1.9"}')
            script = build / "worker.js"
            script.write_text("const version = 1")
            path = folder / "report.json"
            batch.write_report(path, build, results, True)
            report = json.loads(path.read_text())
            self.assertEqual(report["extension_version"], "0.1.9")
            self.assertEqual(report["session"], "manual-sign-in-requested")
            self.assertEqual(report["platforms"]["youtube"], "pass")
            self.assertEqual(report["platforms"]["tiktok"], "fail")
            self.assertEqual(set(report["platforms"]), set(batch.REQUIRED_PLATFORMS))
            self.assertFalse(report["all_five_passed"])
            script.write_text("const version = 2")
            batch.write_report(path, build, results, False)
            revised = json.loads(path.read_text())
            self.assertNotEqual(revised["build_sha256"], report["build_sha256"])
            self.assertEqual(revised["session"], "guest")
