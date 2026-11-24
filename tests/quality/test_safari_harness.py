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
            "optional_host_permissions": ["https://*/*", "http://127.0.0.1/*"],
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

    def test_fixture_mode_installs_once_and_never_needs_uninstall_for_setup(self):
        def install_fixture(driver, directory, modified=False):
            self.assertNotEqual(self.build, directory)
            self.assertTrue(modified)
            copied = json.loads((directory / "manifest.json").read_text())
            self.assertEqual(copied["host_permissions"], ["http://127.0.0.1/*"])
            self.assertEqual(copied["incognito"], "not_allowed")
            self.assertEqual((directory / "background.js").read_text(),
                             (self.build / "background.js").read_text())
            return "fixture-id"

        with patch.multiple(safari, Driver=Mock(return_value=self.driver),
                            publisher=fixture_publisher,
                            install=Mock(side_effect=install_fixture),
                            find_opened_options=Mock(return_value="options"),
                            badge_count=Mock(), request_consent=Mock(),
                            exercise=Mock(return_value={"signed_badge": True}),
                            uninstall=Mock()):
            result = safari.run_extension("session", Mock(), self.build,
                                          pregrant_test_origin=True)
            self.assertEqual(safari.install.call_count, 1)
            safari.uninstall.assert_called_once_with(self.driver, "fixture-id")
            safari.exercise.assert_called_once()
        self.assertTrue(result["signed_badge"])
        self.assertFalse(result["unmodified_package_installed"])
        self.assertFalse(result["native_optional_permission_grant"])
        self.assertTrue(result["disposable_test_copy"])
        self.assertEqual((self.build / "manifest.json").read_bytes(), self.manifest_bytes)

    def test_fixture_assertion_failure_remains_failure(self):
        with patch.multiple(safari, Driver=Mock(return_value=self.driver),
                            publisher=fixture_publisher,
                            install=Mock(return_value="fixture-id"),
                            find_opened_options=Mock(return_value="options"),
                            badge_count=Mock(), request_consent=Mock(),
                            exercise=Mock(side_effect=AssertionError("badge failed")),
                            diagnostics=Mock(return_value={}), uninstall=Mock()):
            with self.assertRaisesRegex(AssertionError, "badge failed"):
                safari.run_extension("session", Mock(), self.build,
                                     pregrant_test_origin=True)


if __name__ == "__main__":
    unittest.main()
