"""Exercise the standard unpacked extension on ordinary HTTP and HTTPS documents with no gallery code."""
import argparse
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from browser_test import TEXT, browser_session, wait_for_registration
from local_test_gallery import wait_for_label
from tools.test_gallery import smoke_assets

ROOT = Path(__file__).resolve().parents[2]
NEWS = "http://news.example.test"
ART = "https://art.example.test"
CDN = "https://media.example.test"
PUBLIC_TUTORIAL = (
    "https://keras.io/examples/generative/fine_tune_via_textual_inversion/"
    "#taking-the-fine-tuned-model-for-a-spin"
)
PUBLIC_OUTPUT = 'img[src$="/fine_tune_via_textual_inversion_42_1.png"]'



def make_video(image, directory):
    # A moving crop of a known generated image tests video transport, frame
    # sampling and the badge. It is not an independent video accuracy sample.
    still = directory / "source.png"
    clip = directory / "pan.webm"
    still.write_bytes(image)
    subprocess.run([
        "ffmpeg", "-v", "error", "-loop", "1", "-framerate", "24", "-i", str(still),
        "-t", "4", "-vf", "scale=512:512,crop=480:480:4+t*6:12", "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuv420p", "-crf", "20", "-b:v", "0", "-threads", "1", "-an", str(clip),
    ], check=True)
    return clip.read_bytes()


def run(build, live=False):
    build = build.resolve()
    samples = smoke_assets(ROOT)
    shell = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Photos</title>'
    denied = []
    with TemporaryDirectory() as profile, TemporaryDirectory() as generation, sync_playwright() as pw:
        clip = make_video(samples[0].content, Path(generation))
        resources = {
            NEWS + "/photo": ("text/html", shell + '<img id="subject" src="/p.png" width="320" height="320">'),
            NEWS + "/p.png": ("image/png", samples[0].content),
            ART + "/feed": ("text/html", shell + '<main></main>'),
            CDN + "/photo.png": ("image/png", samples[2].content),
            ART + "/short": ("text/html", shell + '<img id="cover" width="260" height="260" src="/cover.png"><video controls muted playsinline preload="auto" width="320" height="320" src="/v.webm"></video>'),
            ART + "/cover.png": ("image/png", samples[0].content),
            ART + "/v.webm": ("video/webm", clip),
        }

        def respond(route):
            request = route.request
            if request.method != "GET" or request.url not in resources:
                denied.append([request.method, request.url])
                return route.abort()
            mime, body = resources[request.url]
            headers = {"Access-Control-Allow-Origin": ART} if request.url.startswith(CDN + "/") else {}
            return route.fulfill(status=200, content_type=mime, headers=headers, body=body)

        launch = ["--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
                  "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        with browser_session(pw, profile, launch, argparse.Namespace(browser=None)) as context:
            wait_for_registration(context, build)
            site = context.new_page()
            site.bring_to_front()
            if live:
                response = site.goto(PUBLIC_TUTORIAL, wait_until="domcontentloaded", timeout=45_000)
                assert response and response.ok, "Public tutorial unavailable"
                try:
                    wait_for_label(site, PUBLIC_OUTPUT, True)
                except Exception:
                    details = site.locator(PUBLIC_OUTPUT).evaluate("""image => ({
                      size: [image.naturalWidth, image.naturalHeight],
                      rect: image.getBoundingClientRect().toJSON(),
                      focused: document.hasFocus(), visible: !document.hidden,
                      passwordForm: Boolean(document.querySelector('input[type=password]')),
                      overlays: document.querySelectorAll('label-ai-overlay').length
                    })""")
                    print(json.dumps({"live_tutorial_image": details}), flush=True)
                    raise
                print("Public tutorial output labeled", flush=True)
                site.close()
                site = context.new_page()
                site.bring_to_front()
            context.route(lambda url: urlsplit(url).scheme in {"http", "https"}, respond)
            site.goto(NEWS + "/photo")
            wait_for_label(site, "#subject", True)
            site.goto(ART + "/feed")
            site.evaluate("""src => {
              const image = new Image(320, 320);
              image.id = 'item'; image.crossOrigin = 'anonymous'; image.src = src;
              document.querySelector('main').append(image);
            }""", CDN + "/photo.png")
            wait_for_label(site, "#item", True)
            assert site.locator("[data-label-ai-test-state],[data-label-ai-build]").count() == 0
            site.goto(ART + "/short")
            # Starting playback as soon as the empty overlay host mounts can
            # lose the start of a four-second clip while permission initializes.
            # Wait for a real same-document scan, remove its badge, then play.
            wait_for_label(site, "#cover", True)
            site.locator("#cover").evaluate("(image) => image.remove()")
            site.get_by_text(TEXT, exact=True).wait_for(state="detached")
            site.wait_for_function("document.querySelector('video').readyState >= 3")
            site.locator("video").evaluate("(video) => video.play()")
            site.get_by_text(TEXT, exact=True).wait_for(state="visible", timeout=75_000)
            assert not denied, denied
    return {"same_origin_unsigned_image": True, "dynamic_cors_cdn_image_on_second_origin": True,
            "video_pan_of_generated_still": True, "public_keras_tutorial_image_labeled": live, "unexpected_http_requests": denied}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--live", action="store_true", help="Also visit the public Keras tutorial and check its first sample output")
    args = parser.parse_args()
    print(json.dumps(run(args.build, args.live)))
