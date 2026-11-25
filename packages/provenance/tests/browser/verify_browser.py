"""Run against the local Vite harness. No media is uploaded: fixture bytes enter the page through Playwright."""
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / 'tests/fixtures/provenance'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    requests = []
    page.on('request', lambda request: requests.append((request.method, request.url)))
    page.goto('http://127.0.0.1:4173/')
    page.wait_for_function('typeof window.verifyFixture === "function"')
    results = []
    for name, mime, expected in [
        ('firefly-generated.jpg', 'image/jpeg', 'verified-generated'),
        ('firefly-tampered.jpg', 'image/jpeg', 'invalid'),
        ('camera-edited.jpg', 'image/jpeg', 'verified-other'),
        ('chatgpt-expired.png', 'image/png', 'invalid'),
        ('sora.mp4', 'video/mp4', 'invalid'),
        ('unsigned.png', 'image/png', 'missing'),
    ]:
        encoded = base64.b64encode((FIXTURES / name).read_bytes()).decode()
        result = page.evaluate('([data, mime]) => window.verifyFixture(data, mime)', [encoded, mime])
        results.append({'fixture': name, **result})
        print(json.dumps(results[-1]), flush=True)
        assert result['status'] == expected, (name, result, expected)
        assert result['shouldLabel'] is (expected == 'verified-generated')
    assert all(method == 'GET' and url.startswith('http://127.0.0.1:4173/') for method, url in requests), requests
    assert not any('fixtures' in url for _, url in requests), requests
    print(json.dumps({'verified': len(results), 'networkRequests': len(requests), 'externalRequests': 0, 'uploads': 0}))
    page.evaluate('window.closeVerifier()')
    browser.close()
