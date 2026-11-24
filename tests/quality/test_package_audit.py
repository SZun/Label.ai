import json
import tempfile
import unittest
from pathlib import Path

from tools.audit_packages import inspect_build


class PackagePolicyTests(unittest.TestCase):
    def test_remote_runtime_and_capture_permission_are_reported(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            (base/"manifest.json").write_text(json.dumps({
                "manifest_version":3,"permissions":["tabCapture"],"name":"Label.ai",
                "content_security_policy":{"extension_pages":"script-src 'self'; connect-src *"},
                "background":{"service_worker":"bg.js"}}))
            (base/"bg.js").write_text("")
            (base/"index.html").write_text('<script src="https://remote.example/runtime.js"></script>')
            findings = "\n".join(inspect_build(base))
            self.assertIn("tabCapture",findings)
            self.assertIn("connect-src",findings)
            self.assertIn("remote.example",findings)


    def test_install_permissions_match_the_browser_build_scope(self):
        for name, hosts in (
            ("Label.ai", ["http://*/*", "https://*/*"]),
            ("Label.ai (Local Test)", ["http://localhost/*", "http://127.0.0.1/*"]),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                manifest = {
                    "manifest_version": 3, "name": name, "host_permissions": hosts,
                    "incognito": "not_allowed", "permissions": ["storage", "scripting"],
                    "content_security_policy": {"extension_pages": "script-src 'self'; connect-src 'self'"},
                    "web_accessible_resources": [{"resources": [], "matches": hosts}],
                }
                (base / "manifest.json").write_text(json.dumps(manifest))
                self.assertEqual(inspect_build(base), [])

    def test_test_package_cannot_gain_global_hosts_or_static_scripts(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "manifest.json").write_text(json.dumps({
                "manifest_version": 3, "name": "Label.ai (Local Test)",
                "host_permissions": ["https://*/*"], "optional_host_permissions": ["<all_urls>"],
                "content_scripts": [{"matches":["https://*/*"],"js":[]}],
                "web_accessible_resources": [{"resources": [], "matches": ["https://*/*"]}],
                "content_security_policy": {"extension_pages": "script-src 'self'; connect-src 'self'"},
            }))
            findings = " ".join(inspect_build(base))
            self.assertIn("incognito", findings)
            self.assertIn("host permissions", findings)
            self.assertIn("optional host permissions", findings)
            self.assertIn("static content scripts", findings)
            self.assertIn("web accessible", findings)
