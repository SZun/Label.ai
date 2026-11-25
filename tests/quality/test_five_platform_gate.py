"""Every named live host must run on pull requests and participate in the gate."""
import re
import unittest
from pathlib import Path


class FivePlatformGate(unittest.TestCase):
    def test_gate_requires_five_real_players(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/social-video.yml").read_text()
        social = re.search(r"^  social:\n(.+?)(?=^  [\w-]+:\n|\Z)", workflow, re.M | re.S)
        self.assertIsNotNone(social, "dedicated live social job missing")
        job = social.group(1)
        self.assertRegex(job, r"platform: \[youtube, tiktok, facebook, instagram, x\]")
        self.assertIn('social_video.py --live "$PLATFORM"', job)
        self.assertNotIn("continue-on-error", job)
        self.assertNotIn("github.event.pull_request.body", job)
        self.assertRegex(workflow, r'(?s)  five-platform-acceptance:\s+needs: social\s+if: always\(\).*?needs.social.result')
