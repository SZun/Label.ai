"""Check Safari's opaque installation result and independent fixture acceptance."""
from contextlib import contextmanager
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
import safari_extension as safari


@contextmanager
def fixture_publisher():
    yield "http://127.0.0.1:8765", []


class TestSafariHarness(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.build = Path(self.temp.name)
        self.manifest = {
            "name": "Label.ai",
            "options_ui": {"page": "options.html"},
            "incognito": "not_allowed",
            "background": {"service_worker": "background.js"},
            "host_permissions": ["https://*/*", "http://*/*"],
        }
        self.manifest_bytes = json.dumps(self.manifest).encode()
        (self.build / "manifest.json").write_bytes(self.manifest_bytes)
        (self.build / "background.js").write_text("// original worker")
        (self.build / "options.html").write_text("<title>Real Options</title>")
        self.driver = Mock(spec=safari.Driver)
        self.driver.call.return_value = {"handle": "publisher"}

    def test_install_only_accepts_opaque_id_and_reports_uninstall_block(self):
        # SafariDriver's observed install result does not identify the URL of
        # extension pages, and its DELETE endpoint can return a vendor 404.
        failure = RuntimeError('SafariDriver 404: {"value":{"error":"no such extension"}}')
        self.driver.call.side_effect = [
            {"extension": "com.apple.Safari.UnpackedExtensions.fixture%20(UNSIGNED)"},
            failure,
            failure,
        ]
        with patch.object(safari, "Driver", return_value=self.driver):
            result = safari.run_install_smoke("session", Mock(), self.build)
        self.assertTrue(result["unmodified_package_installed"])
        self.assertFalse(result["cleanup_completed"])
        self.assertEqual((self.build / "manifest.json").read_bytes(), self.manifest_bytes)
        self.assertEqual(self.driver.call.call_count, 3)

    def test_automatic_acceptance_installs_exact_package_before_opening_options(self):
        observed = []

        def install_fixture(driver, directory):
            self.assertEqual(directory, self.build)
            self.assertEqual((directory / "manifest.json").read_bytes(), self.manifest_bytes)
            observed.append("install")
            return "fixture-id"

        def scan_fixture(driver, site, origin):
            observed.append("scan")
            return {"signed_badge": True, "automatic_scanning": True}

        def open_options(driver, identifier, options_path):
            observed.append("options")
            return "options"

        with patch.multiple(safari, Driver=Mock(return_value=self.driver),
                            publisher=fixture_publisher,
                            install=Mock(side_effect=install_fixture),
                            exercise_automatic_scan=Mock(side_effect=scan_fixture),
                            open_original_options=Mock(side_effect=open_options),
                            exercise_controls=Mock(return_value={"global_pause_resume": True}),
                            uninstall=Mock()):
            result = safari.run_extension("session", Mock(), self.build)
            safari.install.assert_called_once_with(self.driver, self.build)
            safari.uninstall.assert_called_once_with(self.driver, "fixture-id")
            self.assertEqual(observed, ["install", "scan", "options"])
        self.assertTrue(result["automatic_scanning"])
        self.assertTrue(result["unmodified_package_installed"])
        self.assertTrue(result["global_pause_resume"])
        self.assertEqual((self.build / "manifest.json").read_bytes(), self.manifest_bytes)

    def test_automatic_badge_failure_remains_failure_without_options_fallback(self):
        with patch.multiple(safari, Driver=Mock(return_value=self.driver),
                            publisher=fixture_publisher,
                            install=Mock(return_value="fixture-id"),
                            exercise_automatic_scan=Mock(side_effect=AssertionError("badge failed")),
                            open_original_options=Mock(),
                            diagnostics=Mock(return_value={}), uninstall=Mock()):
            with self.assertRaisesRegex(AssertionError, "badge failed"):
                safari.run_extension("session", Mock(), self.build)
            safari.open_original_options.assert_not_called()
            safari.uninstall.assert_called_once_with(self.driver, "fixture-id")

    def test_native_options_discovery_failure_remains_failure_after_automatic_scan(self):
        with patch.multiple(safari, Driver=Mock(return_value=self.driver),
                            publisher=fixture_publisher,
                            install=Mock(return_value="fixture-id"),
                            exercise_automatic_scan=Mock(return_value={"signed_badge": True, "automatic_scanning": True}),
                            open_original_options=Mock(side_effect=safari.SetupUnavailable("opaque ID")),
                            diagnostics=Mock(return_value={}), uninstall=Mock()):
            with self.assertRaisesRegex(safari.SetupUnavailable, "opaque ID"):
                safari.run_extension("session", Mock(), self.build)
            safari.uninstall.assert_called_once_with(self.driver, "fixture-id")


if __name__ == "__main__":
    unittest.main()
