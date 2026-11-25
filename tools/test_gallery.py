"""Serve known, digest-checked test media and a browser-local file picker on loopback."""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from urllib.request import urlopen
import subprocess
import sys
from threading import Event, Thread

if __package__:
    from .demo_page import ramp_png
    from .prepare_smoke_media import PHOTOS
    from .prepare_video_smoke import FILES as VIDEO_DIGESTS, MDN
    from .prepare_frontier_dev import BASE as FRONTIER_BASE
else:
    from demo_page import ramp_png
    from prepare_smoke_media import PHOTOS
    from prepare_video_smoke import FILES as VIDEO_DIGESTS, MDN
    from prepare_frontier_dev import BASE as FRONTIER_BASE

ROOT = Path(__file__).resolve().parents[1]


LUMA_FILE = 'videos/v3fae73976c72.mp4'
VIDEO_CHECK_CLIPS = [
    ('generated-video', 'artifacts/frontier-dev/' + LUMA_FILE, FRONTIER_BASE + LUMA_FILE,
     '3fae73976c724425caa902f85d5e77e62c6e57883f5068cb8f77a8fd2e91d4f3',
     'Generated video • Luma Ray 3.2', 'WasItAIGenerated, CC BY 4.0. Five-second generated clip.'),
    ('genuine-video', 'artifacts/video-smoke/flower.mp4', MDN + 'flower.mp4', VIDEO_DIGESTS['flower.mp4'],
     'Camera control • flowers', 'MDN public camera footage. Five-second comparison clip.'),
]


class FixtureError(ValueError):
    """A required public test fixture is missing or differs from the pinned digest."""


@dataclass(frozen=True)
class Asset:
    element_id: str
    title: str
    description: str
    suffix: str
    content: bytes

    @property
    def path(self):
        return '/assets/' + hashlib.sha256(self.content).hexdigest() + self.suffix

    @property
    def mime(self):
        return {'.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4'}[self.suffix]


def verified(path, digest):
    try:
        data = path.read_bytes()
    except OSError as error:
        raise FixtureError(f'Missing test fixture: {path.name}') from error
    if not isinstance(digest, str) or hashlib.sha256(data).hexdigest() != digest:
        raise FixtureError(f'Fixture digest mismatch: {path.name}')
    return data


def signed_asset(root):
    directory = root / 'tests/fixtures/provenance'
    manifest = json.loads((directory / 'manifest.json').read_text())
    row = next(row for row in manifest['assets'] if row['file'] == 'firefly-generated.jpg')
    return Asset('signed', 'Known generated • signed Firefly',
                 'Adobe Firefly example with a verified whole-image C2PA generation assertion.',
                 '.jpg', verified(directory / row['file'], row['sha256']))


def smoke_assets(root):
    digests = json.loads((root / 'tests/fixtures/smoke-digests.json').read_text())
    generated = [name for name in digests if name not in PHOTOS]
    if len(generated) != 4 or set(digests) != set(generated) | set(PHOTOS) or any(
        Path(name).name != name or not name.endswith('.png') for name in digests
    ):
        raise FixtureError('Unexpected pinned image fixture manifest.')
    directory = root / 'artifacts/smoke-media'
    result = []
    for index, (synthetic, camera) in enumerate(zip(generated, PHOTOS), 1):
        result.append(Asset(f'generated-{index}', f'Known generated • image {index}',
                            'Stable Diffusion / DiffusionDB development sample (CC0-1.0).',
                            '.png', verified(directory / synthetic, digests[synthetic])))
        license_name = 'Public domain' if camera == 'astronaut.png' else 'CC0-1.0'
        result.append(Asset(f'genuine-{index}', f'Known genuine • {camera.removesuffix(".png")}',
                            f'Camera photograph by {PHOTOS[camera]} ({license_name}).',
                            '.png', verified(directory / camera, digests[camera])))
    return result


def video_assets(root):
    directory = root / 'artifacts/video-smoke'
    return [
        Asset('generated-video', 'Known generated • Kling clip',
              'Public Kling development dataset sample (CC0-1.0 dataset declaration).',
              '.mp4', verified(directory / 'kling.mp4', VIDEO_DIGESTS['kling.mp4'])),
        Asset('genuine-video', 'Known genuine • flower footage',
              'MDN public camera footage example, for local evaluation.',
              '.mp4', verified(directory / 'flower.mp4', VIDEO_DIGESTS['flower.mp4'])),
    ]


def video_check_assets(root, *, prepare=False):
    samples = []
    for element_id, relative, url, digest, title, description in VIDEO_CHECK_CLIPS:
        path = root / relative
        try:
            data = verified(path, digest)
        except FixtureError:
            if not prepare:
                raise
            print(f'Preparing {title}…', flush=True)
            try:
                with urlopen(url, timeout=45) as response:
                    data = response.read(16 * 1024 * 1024 + 1)
            except OSError as error:
                raise FixtureError(f'Could not download {path.name} ({error})') from error
            if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
                raise FixtureError(f'Fixture digest mismatch: {path.name}')
            path.parent.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(dir=path.parent, delete=False) as output:
                output.write(data)
            Path(output.name).replace(path)
        samples.append(Asset(element_id, title, description, '.mp4', data))
    return samples



def ensure_fixtures(root=ROOT, *, prepare=False, include_videos=False):
    """Verify cached public inputs first; only download when explicitly requested."""
    required = [(signed_asset, 'prepare_provenance_fixtures.py'),
                (smoke_assets, 'prepare_smoke_media.py')]
    if include_videos:
        required.append((video_assets, 'prepare_video_smoke.py'))
    for load, script in required:
        try:
            load(root)
        except FixtureError:
            if not prepare:
                raise
            print(f'Preparing public evaluation fixtures with {script}…', flush=True)
            subprocess.run([sys.executable, str(root / 'tools' / script)], cwd=root, check=True)
            load(root)


def build_assets(root=ROOT, include_videos=False):
    samples = [signed_asset(root), *smoke_assets(root)]
    samples.append(Asset('control', 'Known conventional • gradient',
                         'Procedural grayscale gradient generated by the test server.',
                         '.png', ramp_png()))
    if include_videos:
        samples.extend(video_assets(root))
    return samples


def sample_card(asset, *, loop=False):
    title = escape(asset.title)
    attrs = f'id="{asset.element_id}" src="{asset.path}"'
    if asset.mime.startswith('video/'):
        playback = 'controls playsinline loop' if loop else 'controls playsinline'
        media = f'<video {attrs} {playback} preload="metadata" aria-label="{title}"></video>'
    else:
        media = f'<img {attrs} loading="eager" alt="{title}">'
    return (f'<figure>{media}<figcaption><strong>{title}</strong><small>{escape(asset.description)}</small>'
            '<small class="analysis-status">Not yet scanned.</small></figcaption></figure>')


def scanner_status(expected_version):
    return (f'<p id="scanner-status" role="status" data-expected-version="{escape(expected_version)}">'
            'Waiting for the extension scanner.</p>')


def columns_page(asset, expected_version):
    samples = ''.join(
        f'<div><img id="{position}" src="{asset.path}" width="{width}" height="{width}" '
        f'alt="Stable Diffusion reference image"><p>{position.capitalize()} · {width} px</p>'
        '<small class="analysis-status">Not yet scanned.</small></div>'
        for position, width in [('left', 230), ('center', 160), ('right', 128)]
    )
    return f'''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="label-ai-test-gallery" content="1">
<title>Label.ai column placement check</title>
<script src="/gallery.js" defer></script>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/gallery.css">
</head><body><main>
<h1>Column placement check</h1>
<p>Each column displays a separate copy of the same generated image from DiffusionDB.
Keep the images visible while Label.ai scans them. Each copy should receive its own badge.</p>
{scanner_status(expected_version)}
<div class="column-samples">{samples}</div>
<p><a href="/">Return to the test gallery</a></p>
</main></body></html>'''.encode()


def video_check_page(samples, expected_version):
    cards = ''.join(sample_card(sample, loop=True) for sample in samples)
    return f'''<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="label-ai-test-gallery" content="1"><title>Label.ai video check</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/gallery.css">
<script src="/gallery.js" defer></script></head><body><main>
<h1>Test video detection</h1>
<p>With the regular Label.ai extension enabled, press Play on the Luma clip and watch from the beginning.
Keep this tab in the foreground while the local analysis finishes. Expect a badge on the Luma video.
Pause the Luma clip, then play the camera control from the beginning. It should finish scanning without a badge.</p>
{scanner_status(expected_version)}
<div class="grid">{cards}</div>
<p><a href="{VIDEO_CHECK_CLIPS[0][2]}">Original generated clip</a> ·
<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0 license</a> ·
<a href="{VIDEO_CHECK_CLIPS[1][2]}">Original camera footage</a></p>
</main></body></html>'''.encode()



def page(samples, port, expected_version):
    cards = ''.join(map(sample_card, samples))
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="label-ai-test-gallery" content="1">
<title>Label.ai local test gallery</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="/gallery.css">
<script src="/gallery.js" defer></script>
</head>
<body>
<main>
<header><h1>Label.ai test gallery</h1>
<p>Load Label.ai and open <code>http://127.0.0.1:{port}</code>. Scanning starts automatically. Refresh this page after installation or extension reload. Keep this tab in the foreground, scroll to each sample, and wait for its scan to finish.</p>
<p>The captions document the fixture origins. Label.ai adds its animated overlay when it independently labels the media. The on-device detector also analyzes unsigned media. Statistical detection can miss AI-generated content or produce false positives. <a href="#local-title">Try your own files.</a></p>
{scanner_status(expected_version)}
<p id="build-help">Use the latest regular build from <code>apps/extension/.output/chrome-mv3</code>. In <code>chrome://extensions</code>, reload the updated extension, disable older or duplicate installs, and grant website access.</p></header>
<section aria-labelledby="samples-title"><h2 id="samples-title">Known-origin samples</h2>
<p><a href="/columns">Compare label placement in three columns</a></p><div class="grid">{cards}</div></section>
<section aria-labelledby="local-title"><h2 id="local-title">Try your own files</h2>
<p>Select an image or video, or drag files onto the picker. Your browser displays each file from a local object URL. The server never receives your files. Play short videos normally and keep the page visible until analysis finishes.</p>
<label for="local-files">Select local images or videos</label>
<div class="actions"><input id="local-files" type="file" accept="image/*,video/*" multiple>
<button type="button" id="clear-local">Clear files</button></div>
<p id="local-status" role="status">No local files selected.</p><div id="local-media" class="grid"></div>
</section>
</main></body></html>'''.encode()


STYLE = b'''* { box-sizing: border-box; }
body { margin: 0; color: #202124; background: #f7f8fa; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
main { max-width: 1180px; padding: 20px; margin: auto; }
h1 { font-size: 1.7rem; margin: 0 0 6px; letter-spacing: -.035em; }
h2 { font-size: 1.12rem; margin: 16px 0 10px; }
p { font-size: .92rem; margin: 5px 0 8px; }
code { font-size: .9em; overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 252px), 1fr)); gap: 14px; }
.column-samples { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-block: 24px; }
.column-samples > :nth-child(2) { justify-self: center; }
.column-samples > :last-child { justify-self: end; }
.column-samples > :first-child { justify-self: start; }
.column-samples .analysis-status { display: block; width: 0; min-width: 100%; }
.column-samples img { display: block; max-width: 100%; height: auto; }
@media (max-width: 759px) { .column-samples { grid-template-columns: 1fr; } }
figure { overflow: hidden; margin: 0; border: 1px solid #d9e0ea; background: white; border-radius: 10px; }
figure img, figure video { display: block; width: 100%; height: 230px; object-fit: contain; background: #e9edf2; }
figcaption { padding: 12px; font-size: .91rem; overflow-wrap: anywhere; }
figcaption small { color: #495462; display: block; margin-top: 4px; }
figcaption .analysis-status { border-top: 1px solid #e1e5eb; margin-top: 8px; padding-top: 6px; font-weight: 600; }
#scanner-status { font-weight: 650; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
button { padding: 7px 12px; color: #263246; background: white; border: 1px solid #8b99ac; border-radius: 6px; cursor: pointer; }
label { font-weight: 600; font-size: .92rem; }
section + section { margin-top: 32px; }
'''

SCRIPT = '''"use strict";
const picker = document.getElementById("local-files");
const container = document.getElementById("local-media");
const status = document.getElementById("local-status");
const scannerStatus = document.getElementById("scanner-status");
const stateMessages = Object.freeze({
  pending: "Scanning…",
  labeled: "Positive decision. Badge visible.",
  "completed-no-label": "Last scan completed without a label.",
  unsupported: "Last scan: unsupported media.",
  failed: "Last scan failed. Refresh or retry in the foreground.",
  canceled: "Scan canceled. Keep this sample in view to retry.",
});
function updateScannerStatus() {
  const hosts = Array.from(document.querySelectorAll("label-ai-overlay"));
  const host = hosts[0];
  const build = host?.getAttribute("data-label-ai-build");
  const version = host?.getAttribute("data-label-ai-version");
  const state = host?.getAttribute("data-label-ai-scanner-state");
  const expected = scannerStatus.dataset.expectedVersion;
  const buildName = build === "production" ? "Label.ai" : "Label.ai (Local Test)";
  const activity = {
    active: "Scanner active.",
    starting: "Starting scanner.",
    paused: "Scanning paused. Open Label.ai settings to resume.",
    inactive: "Scanner inactive on this page. Bring this tab to the foreground.",
    "awaiting-access": "Waiting for browser access. Check the extension's site access and active tab.",
    "settings-error": "Cannot read scanner settings. Reload the extension and this page.",
  };
  let message;
  if (!hosts.length) {
    message = "No scanner connected to this tab. Enable Label.ai, grant site access, resume scanning and refresh.";
  } else if (hosts.length > 1) {
    message = "Multiple Label.ai scanners found. Disable duplicate extensions, then refresh.";
  } else if (!version || !["production", "local-test"].includes(build)) {
    message = `Found a scanner without current build diagnostics. Reload the matching ${expected} build and refresh.`;
  } else {
    message = `${buildName} ${version}. ${activity[state] || "Unknown scanner state."}`;
    if (version !== expected) message += ` Gallery expects ${expected}. Rebuild and reload if your extension is outdated.`;
    if (build === "local-test") message += " This build scans local test pages only. Load the regular build for ordinary websites.";
  }
  if (scannerStatus.textContent !== message) scannerStatus.textContent = message;
  // Read rendered badges as well as scanner decisions. A positive decision can
  // precede the overlay render, or outlast it when an item scrolls out of view.
  const badges = hosts.flatMap(h => Array.from(h.shadowRoot?.querySelectorAll(".slop-label") || [],
    badge => badge.getBoundingClientRect()));
  for (const media of document.querySelectorAll("figure > img, figure > video, .column-samples img")) {
    const result = media.parentElement.querySelector(".analysis-status");
    const outcome = media.getAttribute("data-label-ai-test-state");
    let text = Object.hasOwn(stateMessages, outcome) ? stateMessages[outcome] : "Not yet scanned.";
    if (outcome === "labeled") {
      const r = media.getBoundingClientRect();
      const attached = badges.some(b => b.width > 0 && b.height > 0 && b.left >= Math.max(r.left, 0) - 1 &&
        b.top >= Math.max(r.top, 0) - 1 && b.right <= Math.min(r.right, innerWidth) + 1 &&
        b.bottom <= Math.min(r.bottom, innerHeight) + 1);
      if (!attached) {
        const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
          r.left < innerWidth && r.top < innerHeight;
        text = onScreen ? "Positive decision. No badge currently visible on this item." :
          "Positive decision. Scroll this item into view to check the badge.";
      }
    }
    if (result && result.textContent !== text) result.textContent = text;
  }
}
const observer = new MutationObserver(updateScannerStatus);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["data-label-ai-build", "data-label-ai-version", "data-label-ai-scanner-state", "data-label-ai-test-state"],
});
updateScannerStatus();
// Shadow-root placement and layout changes do not mutate the gallery DOM.
window.setInterval(updateScannerStatus, 1000);
let objectUrls = [];
function clearLocal() {
  container.replaceChildren();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  picker.value = "";
  status.textContent = "No local files selected.";
}
function display(files) {
  clearLocal();
  let skipped = 0;
  let loaded = 0;
  let failed = 0;
  function updateStatus() {
    const remaining = objectUrls.length - loaded - failed;
    status.textContent = `${loaded} of ${objectUrls.length} local files displayed.` + (failed ? ` Unable to display ${failed}.` : "") + (remaining ? ` Loading ${remaining}.` : "") + (skipped ? ` Skipped ${skipped}.` : "");
  }
  for (const file of files) {
    if (objectUrls.length >= 12 || !(file.type.startsWith("image/") || file.type.startsWith("video/"))) { skipped++; continue; }
    const isVideo = file.type.startsWith("video/");
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    const media = document.createElement(isVideo ? "video" : "img");
    media.id = "local-media-" + objectUrls.length;
    if (isVideo) {
      media.controls = true;
      media.playsInline = true;
      media.preload = "metadata";
      media.setAttribute("aria-label", file.name);
    } else {
      media.alt = file.name;
    }
    const card = document.createElement("figure");
    const caption = document.createElement("figcaption");
    const captionTitle = document.createElement("span");
    captionTitle.textContent = file.name + " — user-selected, origin unknown";
    const analysisStatus = document.createElement("small");
    analysisStatus.className = "analysis-status";
    analysisStatus.textContent = "Not yet scanned.";
    caption.append(captionTitle, analysisStatus);
    media.addEventListener("error", () => {
      if (!media.isConnected) return;
      captionTitle.textContent = file.name + " — unable to display this file";
      failed++;
      updateStatus();
    }, {once: true});
    media.addEventListener(isVideo ? "loadedmetadata" : "load", () => {
      if (!media.isConnected) return;
      loaded++;
      updateStatus();
    }, {once: true});
    media.src = url;
    card.append(media, caption);
    container.append(card);
  }
  status.textContent = objectUrls.length ? `Loading ${objectUrls.length} local files…` : "No supported files selected.";
  if (skipped) status.textContent += ` Skipped ${skipped}.`;
  if (objectUrls.length) container.scrollIntoView({block: "start"});
}
picker?.addEventListener("change", () => display(Array.from(picker.files)));
document.getElementById("clear-local")?.addEventListener("click", clearLocal);
if (picker) window.addEventListener("pagehide", clearLocal);
'''.encode()

CSP = ("default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob:; "
       "script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; "
       "object-src 'none'; form-action 'none'; frame-ancestors 'none'")


def byte_range(value, size):
    match = re.fullmatch(r'bytes=(\d{0,20})-(\d{0,20})', value or '')
    if not match:
        return None
    start, end = match.groups()
    if not start:
        if not end or int(end) < 1:
            return None
        return max(0, size - int(end)), size - 1
    start = int(start)
    end = min(int(end), size - 1) if end else size - 1
    return (start, end) if 0 <= start <= end < size else None


@contextmanager
def gallery(port=0, root=ROOT, include_videos=False, *, video_check=False):
    """Return a loopback-only, GET-only publisher of an explicit asset allowlist."""
    expected_version = json.loads((ROOT / 'apps/extension/package.json').read_text())['version']
    samples = video_check_assets(root, prepare=True) if video_check else build_assets(root, include_videos)
    resources = {sample.path: (sample.mime, sample.content) for sample in samples}
    if not video_check:
        generated = next(sample for sample in samples if sample.element_id == 'generated-1')
        resources['/columns'] = ('text/html; charset=utf-8', columns_page(generated, expected_version))
    resources['/gallery.css'] = ('text/css; charset=utf-8', STYLE)
    resources['/gallery.js'] = ('text/javascript; charset=utf-8', SCRIPT)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_resource(self, *, head=False):
            # No request bodies or headers are recorded.
            requests.append((self.command, self.path))
            if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                self.send_error(403)
                return
            if self.path == '/':
                mime = 'text/html; charset=utf-8'
                data = (video_check_page(samples, expected_version) if video_check
                        else page(samples, self.server.server_port, expected_version))
            elif self.path in resources:
                mime, data = resources[self.path]
            else:
                self.send_error(404)
                return
            length = len(data)
            range_header = self.headers.get('Range')
            bounds = byte_range(range_header, length) if range_header else None
            if range_header and bounds is None:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{length}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.send_response(206 if bounds else 200)
            if bounds:
                start, end = bounds
                self.send_header('Content-Range', f'bytes {start}-{end}/{length}')
                data = data[start:end + 1]
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'public, max-age=3600' if self.path.startswith('/assets/') else 'no-store')
            self.send_header('Content-Security-Policy', CSP)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if not head:
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def do_GET(self):
            self.send_resource()

        def do_HEAD(self):
            self.send_resource(head=True)

        def do_POST(self):
            # Reject uploads and never read a request body.
            requests.append((self.command, self.path))
            self.send_error(405)

        do_PUT = do_PATCH = do_DELETE = do_POST

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', requests
    finally:
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--prepare', action='store_true', help='Download missing or invalid pinned public test fixtures')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--video-check', action='store_true',
                       help='Prepare just the pinned Luma and camera clips and serve a video-only check')
    modes.add_argument('--videos', action='store_true', help='Include two public video samples')
    args = parser.parse_args()
    try:
        if not args.video_check:
            ensure_fixtures(prepare=args.prepare, include_videos=args.videos)
        with gallery(args.port, include_videos=args.videos, video_check=args.video_check) as (origin, _requests):
            if args.video_check:
                print(f'Open {origin}/ in the regular Label.ai extension and play the Luma clip. Keep this terminal running.', flush=True)
            else:
                print(f'Open {origin} with the regular Label.ai extension enabled. Test column placement at {origin}/columns. Keep this terminal running.', flush=True)
            try:
                Event().wait()
            except KeyboardInterrupt:
                pass
    except FixtureError as error:
        if args.video_check:
            raise SystemExit(str(error)) from error
        raise SystemExit(f'{error}. Run python3 tools/test_gallery.py --prepare (add --videos for videos).') from error


if __name__ == '__main__':
    main()
