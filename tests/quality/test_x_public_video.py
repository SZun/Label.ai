"""Checks for X's external post fixture identity, independent of X guest availability."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from x_public_video import X_POST_URL, is_expected_x_post


class PublicXPostTest(unittest.TestCase):
    def test_accepts_same_primary_post_with_viewer_query_or_video_path(self):
        self.assertTrue(is_expected_x_post(X_POST_URL + "?s=20"))
        self.assertTrue(is_expected_x_post(X_POST_URL.replace("OpenAI", "openai") + "/video/1"))

    def test_rejects_other_posts_including_a_quote_or_login_redirect(self):
        for other in [X_POST_URL + "0", X_POST_URL.replace("/OpenAI/", "/other/"),
                      X_POST_URL.replace("https://x.com", "https://other.example"),
                      "https://x.com/i/flow/login?redirect_after_login=" + X_POST_URL,
                      X_POST_URL + "/analytics", X_POST_URL.replace("https:", "http:")]:
            with self.subTest(other=other):
                self.assertFalse(is_expected_x_post(other))
