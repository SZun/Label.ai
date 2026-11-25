"""Installed-browser test for the segmented detector on 32s of continuous playback."""
import argparse
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright

from browser_test import browser_session, wait_for_registration
from local_test_gallery import wait_for_label
from ordinary_pages import ROOT, TEXT, smoke_assets


def make_long_pan(still, folder):
    """A pan of a pinned generated still exercises transport, not independent accuracy."""
    source = folder / "image.png"
    source.write_bytes(still)
    video = folder / "pan.webm"
    subprocess.run([
        "ffmpeg", "-v", "error", "-loop", "1", "-framerate", "12", "-i", str(source),
        "-t", "32", "-vf", "scale=512:512,crop=384:384:4+3*t:32",
        "-c:v", "libvpx-vp9", "-crf", "24", "-b:v", "0", "-pix_fmt", "yuv420p",
        "-threads", "1", "-an", str(video),
    ], check=True)
    return video.read_bytes()


def run(build, browser=None):
    build = build.resolve()
    still = smoke_assets(ROOT)[0].content
    origin = "https://publisher.example.test"
    with TemporaryDirectory() as profile, TemporaryDirectory() as assets, sync_playwright() as pw:
        video = make_long_pan(still, Path(assets))
        resources = {
            "/watch": ("text/html", '<link rel="icon" href="data:,"><img id="cover" width="260" src="/cover.png">'
                      '<video src="/clip.webm" width="384" height="384" preload="auto" muted playsinline></video>'),
            "/cover.png": ("image/png", still),
            "/clip.webm": ("video/webm", video),
        }
        unexpected = []
        def serve(route):
            request = route.request
            path = request.url.removeprefix(origin)
            if request.method != "GET" or path not in resources:
                unexpected.append((request.method, request.url))
                return route.abort()
            mime, body = resources[path]
            return route.fulfill(content_type=mime, body=body)

        launch = ["--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
                  "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        with browser_session(pw, profile, launch, argparse.Namespace(browser=browser)) as context:
            wait_for_registration(context, build)
            context.route("http*/**", serve)
            page = context.new_page()
            page.bring_to_front()
            page.goto(origin + "/watch")
            wait_for_label(page, "#cover", True)
            page.locator("#cover").evaluate("img => img.remove()")
            badge = page.get_by_text(TEXT, exact=True)
            badge.wait_for(state="detached")
            page.wait_for_function("document.querySelector('video').readyState >= 3")
            page.locator("video").evaluate("v => v.play()")
            page.wait_for_function("document.querySelector('video').currentTime >= 16", timeout=30_000)
            assert not badge.count(), "A single positive half cannot label the full clip"
            badge.wait_for(state="visible", timeout=135_000)
            assert page.locator("video").evaluate("v => v.currentTime > 30")
            assert not unexpected, unexpected
            print("Labeled the 32-second pan after sampling both windows of normal playback", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--browser", help="Chromium executable path")
    args = parser.parse_args()
    run(args.build, args.browser)
