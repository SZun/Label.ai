"""Exercise the installed production extension on publisher-hosted generated video."""
import argparse
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
    # Hit-testing ensures the badge actually paints in front of the fullscreen
    # element. A nonzero rectangle alone also passes behind its opaque backdrop.
    assert site.locator('label-ai-overlay').evaluate(
        "el => getComputedStyle(el).position === 'fixed' && getComputedStyle(el).pointerEvents === 'none'"
    )
    for selector in ("#player", "#film"):
        site.locator(selector).evaluate("el => el.requestFullscreen()")
        site.wait_for_function("s => document.fullscreenElement === document.querySelector(s)", arg=selector)
        wait_for_video_badge(site, "#film")
        site.wait_for_function("""() => {
          const host = document.querySelector('label-ai-overlay');
          const badge = host?.shadowRoot?.querySelector('.slop-label');
          if (!badge) return false;
          const {left,top,width,height} = badge.getBoundingClientRect();
          badge.style.setProperty('pointer-events','auto','important');
          try {
            return document.elementFromPoint(left + width / 2, top + height / 2) === host;
          } finally {
            badge.style.removeProperty('pointer-events');
          }
        }""", timeout=10_000)
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
            if req.url in (PAGE + "/1", PAGE + "/2", PAGE + "/3"):
                index = req.url[-1]
                url = (PAGE if index == "2" else CDN) + "/clip" + index + ".mp4"
                html = ('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Watch</title>'
                        f'<section id="player"><video id="film" width="384" height="320" controls playsinline muted preload="auto" src="{url}"></video></section>')
                return route.fulfill(content_type="text/html", body=html)
            if req.url in (CDN + "/clip1.mp4", PAGE + "/clip2.mp4", CDN + "/clip3.mp4"):
                headers = {"Access-Control-Allow-Origin": PAGE} if req.url.endswith("clip1.mp4") else {}
                if req.resource_type == "fetch":
                    assert not set(req.all_headers()) & {"cookie", "referer", "authorization"}
                    reads.append(req.url)
                return route.fulfill(status=200, content_type="video/mp4", headers=headers,
                                     body=flower if req.url.endswith("clip2.mp4") else luma)
        forbidden.append((req.method, req.url))
        return route.abort()

    context.route(lambda url: urlsplit(url).scheme in {"http", "https"}, publisher)
    site = context.new_page()
    site.bring_to_front()
    for n in (1, 2, 3):
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
        else:
            site.wait_for_function("document.querySelector('video').played.length > 0 && document.querySelector('video').played.end(0) > 4.9", timeout=20_000)
            assert CDN + "/clip3.mp4" in reads
            assert not site.locator("label-ai-overlay .slop-label").count()
    assert not forbidden, forbidden


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
    args = parser.parse_args()
    build = args.build.resolve()
    with TemporaryDirectory() as profile, sync_playwright() as pw:
        launch = ["--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
                  "--disable-background-networking", "--disable-component-update", "--disable-sync"]
        with browser_session(pw, profile, launch, args) as context:
            worker = wait_for_registration(context, build)
            if args.live:
                site = context.new_page()
                site.bring_to_front()
                showcase(site)
            else:
                feed(context, worker)
