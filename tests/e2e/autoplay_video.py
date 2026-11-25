"""Check early scene badges on finite, direct-file players in the installed extension."""
import argparse
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright

from browser_test import browser_session, wait_for_registration
from generated_video import PAGE, ROOT, SHOWCASE, fixture, observe_decisions, wait_for_video_badge
from social_video import GENERATED, GENERATED_HASH, make_segment, start_trace
from tools.prepare_video_smoke import FILES, MDN


def extended_playback(source, folder):
    # Repeat the same real scene so both classes have identical editing and duration.
    # A repeated source measures transport and timing, not independent accuracy.
    segment = folder / "scene.mp4"
    segment.write_bytes(make_segment(source, folder))
    output = folder / "feed.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-stream_loop", "-1", "-i", str(segment),
        "-t", "45", "-c", "copy", "-movflags", "+faststart", str(output),
    ], check=True)
    return output.read_bytes()


def run(args):
    build = args.build.resolve()
    generated = fixture(ROOT / "artifacts/social-video" / GENERATED,
                        SHOWCASE + "video/" + GENERATED, GENERATED_HASH)
    camera = fixture(ROOT / "artifacts/video-smoke/flower.mp4", MDN + "flower.mp4", FILES["flower.mp4"])
    with TemporaryDirectory() as profile, TemporaryDirectory() as folder, sync_playwright() as pw:
        resources = {
            "/watch": ("text/html", '<link rel="icon" href="data:,"><video width="500" height="320" '
                                    'muted playsinline autoplay></video>'),
            "/a.mp4": ("video/mp4", extended_playback(generated, Path(folder))),
            "/b.mp4": ("video/mp4", extended_playback(camera, Path(folder))),
        }
        unexpected = []

        def serve(route):
            path = route.request.url.removeprefix(PAGE)
            if route.request.method == "GET" and path in resources:
                mime, body = resources[path]
                return route.fulfill(content_type=mime, body=body)
            unexpected.append((route.request.method, route.request.url))
            return route.abort()

        flags = [f"--disable-extensions-except={build}", f"--load-extension={build}",
                 "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        with browser_session(pw, profile, flags, args) as context:
            worker = wait_for_registration(context, build)
            context.route("http*/**", serve)
            page = context.new_page()
            page.bring_to_front()
            page.goto(PAGE + "/watch")
            page.locator("label-ai-overlay").wait_for(state="attached")
            observe_decisions(worker)
            start_trace(worker)
            video = page.locator("video")
            for path, expected in (("/a.mp4", "positive"), ("/b.mp4", "negative")):
                worker.evaluate("globalThis.socialTrace.length = 0")
                video.evaluate("""(v, path) => {
                    delete document.documentElement.dataset.videoTestDecision;
                    v.src = path; return v.play();
                }""", path)
                page.wait_for_function("expected => document.documentElement.dataset.videoTestDecision === expected",
                                       arg=expected, timeout=45_000)
                if expected == "positive":
                    wait_for_video_badge(page, "video")
                else:
                    assert not page.locator('label-ai-overlay [aria-label="Video analysis"] .slop-label').count()
                trace = worker.evaluate("globalThis.socialTrace")
                assert any(row[1] == "playback-window" and row[2] >= 8 for row in trace), trace
                time, duration = video.evaluate("v => [v.currentTime, v.duration]")
                assert 4 <= time < duration - 1, (expected, time, duration, trace)
                print(f"{expected} at {time:.1f}s of {duration:.1f}s, {trace}", flush=True)
            assert not unexpected, unexpected


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--browser")
    run(parser.parse_args())
