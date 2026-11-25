import hashlib
import http.client
import json
from html.parser import HTMLParser
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.demo_page import ramp_png
from tools.test_gallery import FixtureError, ensure_fixtures, gallery


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        fixtures = self.root / 'tests/fixtures'
        smoke = self.root / 'artifacts/smoke-media'
        provenance = fixtures / 'provenance'
        smoke.mkdir(parents=True)
        provenance.mkdir(parents=True)
        self.photo = ramp_png()
        self.signed = b'gallery HTTP fixture bytes (not a credential proof)'
        self.signed_digest = hashlib.sha256(self.signed).hexdigest()
        (provenance / 'firefly-generated.jpg').write_bytes(self.signed)
        (provenance / 'manifest.json').write_text(json.dumps({'assets': [
            {'file': 'firefly-generated.jpg', 'sha256': self.signed_digest},
        ]}))
        names = [f'generated-{i}.png' for i in range(4)] + ['camera.png', 'coffee.png', 'chelsea.png', 'astronaut.png']
        digests = {}
        for index, name in enumerate(names):
            data = self.photo + bytes([index])
            (smoke / name).write_bytes(data)
            digests[name] = hashlib.sha256(data).hexdigest()
        (fixtures / 'smoke-digests.json').write_text(json.dumps(digests))
        self.generated_digest = digests[names[0]]

    def request(self, origin, method, path, body=None, headers=None):
        host, port = origin.removeprefix('http://').split(':')
        self.assertEqual(host, '127.0.0.1')
        connection = http.client.HTTPConnection(host, int(port), timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_loopback_gallery_contains_attributed_real_test_slots(self):
        with gallery(root=self.root) as (origin, _requests):
            status, headers, body = self.request(origin, 'GET', '/')
            self.assertEqual(status, 200)
            html = body.decode()
            for element_id in ['signed', 'generated-1', 'genuine-1', 'control', 'local-files', 'local-status', 'clear-local', 'scanner-status']:
                self.assertIn(f'id="{element_id}"', html)
            self.assertIn('DiffusionDB', html)
            self.assertIn('camera', html.lower())
            self.assertIn('/assets/' + self.generated_digest + '.png', html)
            self.assertIn("form-action 'none'", headers['Content-Security-Policy'])
            status, headers, body = self.request(origin, 'GET', '/assets/' + self.signed_digest + '.jpg')
            self.assertEqual((status, headers['Content-Type'], body), (200, 'image/jpeg', self.signed))

    def test_columns_page_reports_each_separately_scanned_image(self):
        images = []

        class Images(HTMLParser):
            def handle_starttag(self, tag, attrs):
                if tag == 'img':
                    images.append(dict(attrs))

        with gallery(root=self.root) as (origin, _):
            status, headers, body = self.request(origin, 'GET', '/columns')
            self.assertEqual(status, 200)
            self.assertIn('text/html', headers['Content-Type'])
            Images().feed(body.decode())
            self.assertEqual([image['id'] for image in images], ['left', 'center', 'right'])
            self.assertEqual([image['width'] for image in images], ['230', '160', '128'])
            self.assertEqual({image['src'] for image in images}, {'/assets/' + self.generated_digest + '.png'})
            self.assertIn(b'src="/gallery.js"', body)
            self.assertIn(b'<meta name="label-ai-test-gallery" content="1">', body)
            self.assertEqual(body.count(b'class="analysis-status"'), 3)
            local_version = json.loads((Path(__file__).resolve().parents[2] /
                                        'apps/extension/package.json').read_text())['version']
            self.assertIn(f'data-expected-version="{local_version}"'.encode(), body)
            self.assertIn(b'id="scanner-status"', body)
            self.assertIn(b'href="/gallery.css"', body)
            self.assertIn(b'href="/columns"', self.request(origin, 'GET', '/')[2])

    def test_asset_allowlist_and_upload_denial(self):
        with gallery(root=self.root) as (origin, requests):
            for path in ['/../../etc/passwd', '/assets/unknown.png', '/assets/' + self.signed_digest + '.jpg?other=1']:
                self.assertEqual(self.request(origin, 'GET', path)[0], 404)
            self.assertEqual(self.request(origin, 'POST', '/', body=b'no upload')[0], 405)
            self.assertEqual(self.request(origin, 'PUT', '/assets/' + self.signed_digest + '.jpg', body=b'no upload')[0], 405)
            self.assertTrue(all(len(entry) == 2 for entry in requests))
            self.assertEqual(self.request(origin, 'GET', '/', headers={'Host': 'other.example'})[0], 403)

    def test_cached_fixtures_are_not_downloaded_and_modified_inputs_are_refused(self):
        with patch('tools.test_gallery.subprocess.run') as run:
            ensure_fixtures(self.root, prepare=True)
            run.assert_not_called()
        (self.root / 'artifacts/smoke-media/camera.png').write_bytes(b'changed')
        with self.assertRaisesRegex(FixtureError, 'camera.png'):
            with gallery(root=self.root):
                self.fail('modified fixture served')

    def test_video_byte_ranges_are_bounded(self):
        directory = self.root / 'artifacts/video-smoke'
        directory.mkdir()
        clips = {'kling.mp4': b'generated test clip bytes', 'flower.mp4': b'genuine test clip bytes'}
        digests = {}
        for name, data in clips.items():
            (directory / name).write_bytes(data)
            digests[name] = hashlib.sha256(data).hexdigest()
        with patch('tools.test_gallery.VIDEO_DIGESTS', digests):
            with gallery(root=self.root, include_videos=True) as (origin, _requests):
                path = '/assets/' + digests['kling.mp4'] + '.mp4'
                status, headers, data = self.request(origin, 'GET', path, headers={'Range': 'bytes=0-3'})
                self.assertEqual((status, data), (206, clips['kling.mp4'][:4]))
                self.assertEqual(headers['Content-Range'], f'bytes 0-3/{len(clips["kling.mp4"])}')
                self.assertEqual(self.request(origin, 'GET', path, headers={'Range': 'bytes=1000-'})[0], 416)

    def test_picker_creates_local_object_urls_only(self):
        with gallery(root=self.root) as (origin, _requests):
            status, headers, source = self.request(origin, 'GET', '/gallery.js')
            self.assertEqual(status, 200)
            self.assertIn('javascript', headers['Content-Type'])
            self.assertIn(b'URL.createObjectURL(file)', source)
            self.assertIn(b'URL.revokeObjectURL', source)
            self.assertIn(b'local-media-', source)
            self.assertNotIn(b'fetch(', source)
            self.assertNotIn(b'XMLHttpRequest', source)

    def test_gallery_exposes_build_and_result_diagnostics(self):
        with gallery(root=self.root) as (origin, _):
            _, _, body = self.request(origin, 'GET', '/')
            self.assertIn(b'<meta name="label-ai-test-gallery" content="1">', body)
            self.assertIn(b'apps/extension/.output/chrome-mv3', body)
            self.assertIn(b'class="analysis-status"', body)
            _, _, script = self.request(origin, 'GET', '/gallery.js')
            for value in (b'data-label-ai-build', b'data-label-ai-test-state', b'completed-no-label',
                          b'data-label-ai-version', b'data-label-ai-scanner-state', b'local-test',
                          b'production', b'outdated', b'Not yet scanned'):
                self.assertIn(value, script)
            self.assertIn(b'attributeFilter', script)
