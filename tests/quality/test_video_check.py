import hashlib
import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

from tools import test_gallery as app


class VideoCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = {'luma': b'generated clip contents', 'flower': b'camera clip contents'}
        self.clips = [
            ('generated-video', 'artifacts/test/luma.mp4', 'https://test.example/luma',
             self.digest('luma'), 'Luma Ray 3.2', 'WasItAIGenerated, CC BY 4.0.'),
            ('genuine-video', 'artifacts/test/flower.mp4', 'https://test.example/flower',
             self.digest('flower'), 'Camera control', 'MDN camera footage.'),
        ]

    def digest(self, name):
        return hashlib.sha256(self.data[name]).hexdigest()

    def test_downloads_only_the_two_pinned_clips_and_reuses_the_verified_cache(self):
        self.assertEqual(
            [clip[3] for clip in app.VIDEO_CHECK_CLIPS],
            ['3fae73976c724425caa902f85d5e77e62c6e57883f5068cb8f77a8fd2e91d4f3',
             '0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451'])
        with patch.object(app, 'VIDEO_CHECK_CLIPS', self.clips), patch.object(app, 'urlopen') as download:
            download.side_effect = [io.BytesIO(content) for content in self.data.values()]
            samples = app.video_check_assets(self.root, prepare=True)
            self.assertEqual([s.content for s in samples], list(self.data.values()))
            self.assertEqual(download.call_count, 2)
            self.assertEqual(samples, app.video_check_assets(self.root, prepare=True))
            self.assertEqual(download.call_count, 2)
            self.assertFalse((self.root / 'artifacts/smoke-media').exists())

    def test_fails_closed_on_a_changed_download(self):
        with patch.object(app, 'VIDEO_CHECK_CLIPS', self.clips), patch.object(app, 'urlopen') as download:
            download.return_value = io.BytesIO(b'changed')
            with self.assertRaises(app.FixtureError):
                app.video_check_assets(self.root, prepare=True)
            self.assertFalse((self.root / self.clips[0][1]).exists())

    def test_video_only_page_uses_native_players_local_paths_and_real_scanner_status(self):
        with patch.object(app, 'VIDEO_CHECK_CLIPS', self.clips), patch.object(app, 'urlopen') as download:
            download.side_effect = [io.BytesIO(content) for content in self.data.values()]
            samples = app.video_check_assets(self.root, prepare=True)
        body = app.video_check_page(samples, 'v-test').decode()
        self.assertEqual(re.findall(r'<video [^>]*src="([^"]+)"', body), [s.path for s in samples])
        self.assertEqual(body.count(' controls '), 2)
        self.assertEqual(len(re.findall(r'<video [^>]*\bloop\b', body)), 2)
        self.assertNotIn('loop', app.sample_card(samples[0]))
        self.assertEqual(body.count('class="analysis-status"'), 2)
        self.assertIn('label-ai-test-gallery', body)
        self.assertIn('v-test', body)
        self.assertIn('camera', body.lower())
        self.assertNotIn('slop-label', body)
        self.assertNotIn('<label-ai-overlay', body)

    def test_video_check_route_serves_only_its_pinned_media_and_honors_byte_ranges(self):
        with patch.object(app, 'VIDEO_CHECK_CLIPS', self.clips), patch.object(app, 'urlopen') as download:
            download.side_effect = [io.BytesIO(content) for content in self.data.values()]
            with app.gallery(root=self.root, video_check=True) as (origin, requests):
                with urlopen(origin, timeout=3) as response:
                    self.assertEqual(response.status, 200)
                    paths = re.findall(r'<video [^>]*src="([^"]+)"', response.read().decode())
                self.assertEqual(len(paths), 2)
                for path, data in zip(paths, self.data.values()):
                    with urlopen(Request(origin + path, headers={'Range': 'bytes=0-3'}), timeout=3) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.headers['Content-Range'], f'bytes 0-3/{len(data)}')
                        self.assertEqual(response.read(), data[:4])
                self.assertEqual(requests, [('GET', '/'), *(('GET', path) for path in paths)])
