"""Exercise the installed production extension on publisher-hosted generated video."""
import argparse
import base64
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from contextlib import nullcontext
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

from browser_test import browser_session, wait_for_registration
from tools.prepare_video_smoke import FILES, MDN

ROOT = Path(__file__).resolve().parents[2]
PAGE = "https://news.example.test"
CDN = "https://media.example.test"
SHOWCASE = "https://ailab-cvc.github.io/videocrafter2/"
LUMA = "videos/v3fae73976c72.mp4"
LUMA_HASH = "3fae73976c724425caa902f85d5e77e62c6e57883f5068cb8f77a8fd2e91d4f3"
BASE = "https://huggingface.co/datasets/wasitaigeneratedcom/frontier-image-video-bench-2026-10/resolve/e6a8b83d15fab1da958848368fcd07e943afafd0/"

def fixture(path, source, digest):
    if path.is_file():
        data = path.read_bytes()
    else:
        with urlopen(source, timeout=45) as response:
            data = response.read(16 * 1024 * 1024 + 1)
    assert hashlib.sha256(data).hexdigest() == digest, source
    return data


def wait_for_video_badge(site, target):
    site.wait_for_function("""selector => {
      const video = document.querySelector(selector);
      if (!video || !video.videoWidth) return false;
      const r = video.getBoundingClientRect();
      return [...document.querySelectorAll('label-ai-overlay')].some(host =>
        [...host.shadowRoot.querySelectorAll('[aria-label="Video analysis"] .slop-label')].some(badge => {
          const b = badge.getBoundingClientRect();
          return b.width > 0 && Math.abs(b.left - Math.max(0,r.left) - 8) < 3 &&
                  Math.abs(b.top - Math.max(0,r.top) - 8) < 3;
        }));
    }""", arg=target, timeout=100_000)


def check_fullscreen_badge(site):
    # A user can fullscreen the entire player UI or use the native video control.
    # A nonzero rectangle alone also passes behind an opaque fullscreen backdrop.
    assert site.locator('label-ai-overlay').evaluate(
        "el => getComputedStyle(el).position === 'fixed' && getComputedStyle(el).pointerEvents === 'none'"
    )
    for selector in ("#player", "#film"):
        print(f"Entering fullscreen on {selector}", flush=True)
        site.locator(selector).evaluate("el => el.requestFullscreen()")
        site.wait_for_function("s => document.fullscreenElement === document.querySelector(s)", arg=selector)
        wait_for_video_badge(site, "#film")
        badge = site.locator('label-ai-overlay [aria-label="Video analysis"] .slop-label')
        badge.evaluate("el => Promise.all(el.getAnimations().map(a => a.finished))")
        bounds = badge.bounding_box()
        assert bounds, (selector, "missing video badge")
        screenshot = site.screenshot(clip=bounds)
        # Inspect Chrome's compositor output. The production badge stays click-through,
        # including when the browser retargets native hit tests to the video itself.
        colors = site.evaluate("""async encoded => {
          const picture = new Image();
          picture.src = 'data:image/png;base64,' + encoded;
          await picture.decode();
          const canvas = document.createElement('canvas');
          canvas.width = picture.width; canvas.height = picture.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(picture, 0, 0);
          const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let background = 0, lettering = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] === 33 && data[i+1] === 33 && data[i+2] === 33) background++;
            if (data[i] > 245 && data[i+1] > 245 && data[i+2] > 245) lettering++;
          }
          return {background, lettering, pixels: data.length / 4};
        }""", base64.b64encode(screenshot).decode("ascii"))
        state = badge.evaluate("""el => {
          const host = el.getRootNode().host, r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
          return {fullscreen: document.fullscreenElement?.id, anchor: host.parentElement?.tagName,
                  popover: host.matches(':popover-open'), hit: hit?.tagName};
        }""")
        print(f"{selector} badge paint {colors}, player state {state}", flush=True)
        assert colors["background"] > colors["pixels"] * .35 and colors["lettering"] > 20, (selector, colors, state)
        assert state["hit"] != "LABEL-AI-OVERLAY", (selector, "badge blocks player controls")
        site.evaluate("document.exitFullscreen()")
        wait_for_video_badge(site, "#film")
        assert site.locator('html > label-ai-overlay').count() == 1


def observe_decisions(worker):
    worker.evaluate("""async () => {
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:() => {
        if (location.origin !== 'https://news.example.test') return;
        const runtime = globalThis.browser?.runtime ?? chrome.runtime;
        const send = runtime.sendMessage.bind(runtime);
        runtime.sendMessage = (...args) => {
          const reply = send(...args);
          if (args[0]?.kind === 'video' && args[0]?.frames) reply.then(result => {
            if (result?.status === 'COMPLETED') document.documentElement.dataset.videoTestDecision =
              result.shouldLabel ? 'positive' : 'negative';
          });
          return reply;
        };
      }});
    }""")


def feed(context, worker):
    # No origins, URLs or credentials from real browsing are supplied to the test.
    luma = fixture(ROOT / "artifacts/frontier-dev" / LUMA, BASE + LUMA, LUMA_HASH)
    flower = fixture(ROOT / "artifacts/video-smoke/flower.mp4", MDN + "flower.mp4", FILES["flower.mp4"])
    reads, forbidden = [], []

    def publisher(route):
        req = route.request
        if req.method == "GET":
            if req.url in (PAGE + "/1", PAGE + "/2", PAGE + "/3", PAGE + "/4"):
                index = req.url[-1]
                url = (PAGE if index == "2" else CDN) + "/clip" + index + ".mp4"
                html = ('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Watch</title>'
                        f'<section id="player"><video id="film" width="384" height="320" controls playsinline muted preload="auto" src="{url}"></video></section>')
                return route.fulfill(content_type="text/html", body=html)
            if req.url in (CDN + "/clip1.mp4", PAGE + "/clip2.mp4", CDN + "/clip3.mp4", CDN + "/clip4.mp4"):
                headers = {"Access-Control-Allow-Origin": PAGE} if req.url.endswith(("clip1.mp4", "clip4.mp4")) else {}
                if req.resource_type == "fetch":
                    assert not set(req.all_headers()) & {"cookie", "referer", "authorization"}
                    reads.append(req.url)
                    if req.url.endswith("clip4.mp4"):
                        # This CDN returns the complete selected representation to an
                        # anonymous fetch with a CORS-exposed range and generic binary MIME.
                        headers.update({"Access-Control-Expose-Headers": "Content-Range",
                                        "Content-Range": f"bytes 0-{len(luma)-1}/{len(luma)}"})
                        return route.fulfill(status=206, content_type="application/octet-stream",
                                             headers=headers, body=luma)
                return route.fulfill(status=200, content_type="video/mp4", headers=headers,
                                     body=flower if req.url.endswith("clip2.mp4") else luma)
        forbidden.append((req.method, req.url))
        return route.abort()

    context.route(lambda url: urlsplit(url).scheme in {"http", "https"}, publisher)
    site = context.new_page()
    site.bring_to_front()
    for n in (1, 2, 3, 4):
        site.goto(PAGE + "/" + str(n))
        site.locator("label-ai-overlay").wait_for(state="attached")
        site.wait_for_function("document.querySelector('video').readyState >= 3")
        observe_decisions(worker)
        expected_read = site.expect_request(
            lambda req: req.resource_type == "fetch" and req.url == CDN + "/clip3.mp4",
            timeout=40_000,
        ) if n == 3 else nullcontext()
        with expected_read:
            site.locator("video").evaluate("(v) => {v.loop=true;return v.play()}")
        if n == 1:
            wait_for_video_badge(site, "#film")
            check_fullscreen_badge(site)
            assert CDN + "/clip1.mp4" in reads
            print("Labeled actual Luma Ray generated footage in an ordinary cross-origin HTTPS player", flush=True)
        elif n == 2:
            site.wait_for_function("document.documentElement.dataset.videoTestDecision === 'negative'", timeout=100_000)
            assert not site.locator("label-ai-overlay .slop-label").count()
            print("Completed camera-footage scan without a badge", flush=True)
        elif n == 4:
            wait_for_video_badge(site, "#film")
            assert reads.count(CDN + "/clip4.mp4") == 1
            print("Labeled the playing video after one complete binary CDN range response", flush=True)
        else:
            site.wait_for_function("document.querySelector('video').played.length > 0 && document.querySelector('video').played.end(0) > 4.9", timeout=20_000)
            assert CDN + "/clip3.mp4" in reads
            assert not site.locator("label-ai-overlay .slop-label").count()
    assert not forbidden, forbidden


def video_check(site):
    from tools.test_gallery import gallery
    with gallery(video_check=True) as (origin, requests):
        site.goto(origin)
        site.locator('label-ai-overlay[data-label-ai-scanner-state="active"]').wait_for(
            state="attached", timeout=30_000)
        for player_id in ['generated-video','genuine-video']:
            target = site.locator('#' + player_id)
            target.scroll_into_view_if_needed()
            assert target.evaluate("v => v.loop")
            target.evaluate("v => { v.muted = true; return v.play(); }")
            if player_id == 'generated-video':
                site.locator('#generated-video[data-label-ai-test-state="labeled"]').wait_for(timeout=100_000)
                badge = site.locator('label-ai-overlay [aria-label="Video analysis"] .slop-label')
                badge.wait_for(state="visible")
                player_box, badge_box = target.bounding_box(), badge.bounding_box()
                assert player_box and badge_box
                assert abs(badge_box["x"] - max(0, player_box["x"]) - 8) < 3
                assert abs(badge_box["y"] - max(0, player_box["y"]) - 8) < 3
                print("Video check: production extension displayed a Luma video badge", flush=True)
            else:
                site.locator('#genuine-video[data-label-ai-test-state="completed-no-label"]').wait_for(timeout=100_000)
                assert target.evaluate("""v => {
                  const t=v.getBoundingClientRect();
                  return [...document.querySelector('label-ai-overlay').shadowRoot.querySelectorAll('.slop-label')]
                    .every(b=>!b.checkVisibility() || Math.abs(b.getBoundingClientRect().left-t.left-8)>3 ||
                      Math.abs(b.getBoundingClientRect().top-Math.max(t.top,0)-8)>3);
                }""")
                print("Video check: production extension analyzed camera footage without a badge", flush=True)
            target.evaluate("v => v.pause()")
        assert all(method in ('GET','HEAD') for method,_ in requests)


def direct_public_clip(site):
    url = SHOWCASE + "video/a_little_boy.mp4"
    response = site.goto(url, wait_until="domcontentloaded", timeout=45_000)
    assert response and response.ok and response.headers.get("content-type", "").startswith("video/mp4")
    player = site.locator("video").first
    player.wait_for(state="visible")
    site.locator("label-ai-overlay").wait_for(state="attached")
    site.wait_for_function("document.querySelector('video').readyState >= 2")
    # Same actions as enabling Loop in Chrome's native context menu and pressing Play.
    player.evaluate("v => { v.loop = true; v.muted = true; return v.play() }")
    site.wait_for_function("document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames >= 3")
    assert player.evaluate("v => v.currentSrc") == url
    wait_for_video_badge(site, "video")
    print(f"Video-specific badge on Chrome's native standalone MP4 player: {url}", flush=True)


def showcase(site):
    site.goto(SHOWCASE, wait_until="domcontentloaded", timeout=50_000)
    # The publisher rotates slides every 4s and clones them for looping. Hover
    # uses its own pause-on-hover control. Hit-test the slide actually on screen.
    carousel = site.locator("#results-carousel")
    carousel.scroll_into_view_if_needed()
    carousel.hover()
    site.wait_for_function("""() => {
        const carousel = document.querySelector('#results-carousel');
        const player = [...carousel.querySelectorAll('video')].find(v => {
            const r=v.getBoundingClientRect();
            const x=Math.max(0,r.left) + Math.min(innerWidth - Math.max(0,r.left),r.width) / 2;
            const y=Math.max(0,r.top) + Math.min(innerHeight - Math.max(0,r.top),r.height) / 2;
            return r.width >= 128 && document.elementFromPoint(x,y) === v;
        });
        if (!player) return false;
        player.dataset.testSelected = '1';
        return true;
    }""")
    target = site.locator('video[data-test-selected="1"]')
    print("Watching visible publisher slide", target.evaluate("v => v.currentSrc"), flush=True)
    target.evaluate("v => v.play()")
    wait_for_video_badge(site, 'video[data-test-selected="1"]')
    print("Labeled a real looping generated video on the live VideoCrafter2 project page", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--browser")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--direct", action="store_true")
    parser.add_argument("--video-check", action="store_true")
    args = parser.parse_args()
    build = args.build.resolve()
    with TemporaryDirectory() as profile, sync_playwright() as pw:
        launch = ["--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
                  "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        with browser_session(pw, profile, launch, args) as context:
            worker = wait_for_registration(context, build)
            if args.video_check:
                site = context.new_page()
                site.bring_to_front()
                video_check(site)
            elif args.direct:
                site = context.new_page()
                site.bring_to_front()
                direct_public_clip(site)
            elif args.live:
                site = context.new_page()
                site.bring_to_front()
                showcase(site)
            else:
                feed(context, worker)
