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
PUBLIC_ARTICLE = "https://en.wikipedia.org/wiki/Stable_Diffusion#Image_modification"
PUBLIC_CDN_OUTPUTS = (
    'img[src*="NightCitySphere"][src*="SD1.5"]',
    'img[src*="NightCitySphere"][src*="SDXL"]',
)
PUBLIC_OUTPUTS = [f'img[src$="/fine_tune_via_textual_inversion_{number}_1.png"]' for number in (42, 43, 44, 45)]



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
    anonymous_reads = []
    article_status = None
    article_labels = 0
    with TemporaryDirectory() as profile, TemporaryDirectory() as generation, sync_playwright() as pw:
        clip = make_video(samples[0].content, Path(generation))
        resources = {
            NEWS + "/photo": ("text/html", shell + '<img id="subject" src="/p.png" width="320" height="320">'),
            NEWS + "/p.png": ("image/png", samples[0].content),
            ART + "/feed": ("text/html", shell + '<main></main>'),
            CDN + "/photo.png": ("image/png", samples[2].content),
            CDN + "/plain.png": ("image/png", samples[0].content),
            CDN + "/restricted.png": ("image/png", samples[0].content),
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
            is_cdn = request.url.startswith(CDN + "/")
            headers = {"Access-Control-Allow-Origin": ART} if is_cdn and not request.url.endswith("/restricted.png") else {}
            if is_cdn and request.resource_type == "fetch":
                sent = request.all_headers()
                assert not any(key in sent for key in ("cookie", "referer", "authorization")), "CDN read sent identifying headers"
                anonymous_reads.append(request.url)
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
                for selector in PUBLIC_OUTPUTS:
                    wait_for_label(site, selector, True)
                    print("Labeled public Keras output", selector, flush=True)
                response = site.goto(PUBLIC_ARTICLE, wait_until="domcontentloaded", timeout=45_000)
                article_status = response.status if response else None
                if article_status in (403, 429):
                    print(f"::warning::Live Wikipedia check blocked by publisher (HTTP {article_status}); no detection result.", flush=True)
                else:
                    assert response and response.ok, f"Public Wikipedia article returned {article_status}"
                    for selector in PUBLIC_CDN_OUTPUTS:
                        wait_for_label(site, selector, True)
                        article_labels += 1
                        print("Labeled Wikimedia-hosted image in live article", selector, flush=True)
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
            # Common publisher markup omits crossorigin even when its CDN
            # allows anonymous reads. Exercise the unchanged, tainted <img>.
            site.evaluate("""src => {
                const image = new Image(240, 160);
                image.id = 'plain'; image.src = src;
                document.querySelector('main').replaceChildren(image);
            }""", CDN + "/plain.png")
            wait_for_label(site, "#plain", True)
            assert CDN + "/plain.png" in anonymous_reads
            with site.expect_request(lambda req: req.url == CDN + "/restricted.png" and req.resource_type == "fetch"):
                site.locator("#plain").evaluate("(img, src) => { img.src = src }", CDN + "/restricted.png")
            wait_for_label(site, "#plain", False)
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
            "video_pan_of_generated_still": True, "public_keras_tutorial_images_labeled": 4 if live else 0, "public_wikipedia_http_status": article_status, "public_wikipedia_images_labeled": article_labels,
            "plain_cdn_image_labeled": True, "unexpected_http_requests": denied}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--live", action="store_true", help="Also check public Keras outputs and Wikimedia-hosted thumbnails")
    args = parser.parse_args()
    print(json.dumps(run(args.build, args.live)))
