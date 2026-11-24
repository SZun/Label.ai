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
