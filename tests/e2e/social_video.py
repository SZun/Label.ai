"""Exercise installed Label.ai in a streaming feed or on a signed-out social permalink."""
import argparse
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

from playwright.sync_api import Error as BrowserError, sync_playwright

from browser_test import browser_session, wait_for_registration
from generated_video import PAGE, ROOT, SHOWCASE, fixture, observe_decisions, wait_for_video_badge
from tools.prepare_video_smoke import FILES, MDN

YOUTUBE = "https://www.youtube.com/watch?v=Itbc12qXr30"
# The original Bigfoot Vlog 1 is documented at knowyourmeme.com/memes/ai-bigfoot-and-yeti-vlogs.
TIKTOK = "https://www.tiktok.com/@bigfootvlogs/video/7508418787968830742"
BLUESKY = "https://bsky.app/profile/carnage4life.bsky.social/post/3m23sq2iios2g"
PERMALINKS = {"youtube": YOUTUBE, "tiktok": TIKTOK, "bluesky": BLUESKY}
GENERATED = "a_little_boy.mp4"
GENERATED_HASH = "2b14849b68b0379111e9e82f6e95240a3c9ceee241d78a37d84a0fd8890be259"


def make_segment(source, work):
    # Ping-pong the short scene to keep its motion continuous across segment boundaries.
    path = work / "input.mp4"
    path.write_bytes(source)
    output = work / "clip.mp4"
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-filter_complex",
        "[0:v]scale=512:-2,setsar=1,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,fps=24",
        "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "fast", "-crf", "19",
        "-profile:v", "baseline", "-level", "3.0", "-threads", "2", "-g", "24", "-bf", "0",
        "-movflags", "empty_moov+frag_keyframe+default_base_moof", str(output),
    ], check=True)
    return output.read_bytes()


START_STREAM = """async path => {
  const video = document.querySelector('video');
  const source = new MediaSource();
  const previous = video.src;
  video.src = URL.createObjectURL(source);
  if (previous) URL.revokeObjectURL(previous);
  await new Promise(resolve => source.addEventListener('sourceopen', resolve, {once:true}));
  const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c01e"');
  const asset = await (await fetch(path)).arrayBuffer();
  buffer.mode = 'sequence';
  buffer.timestampOffset = 70;
  while (!buffer.buffered.length || buffer.buffered.end(0) < 120) {
    const done = new Promise((resolve, reject) => {
      buffer.addEventListener('error', reject, {once:true});
      buffer.addEventListener('updateend', resolve, {once:true});
    });
    buffer.appendBuffer(asset);
    await done;
  }
  source.duration = Infinity;
  source.setLiveSeekableRange(70, buffer.buffered.end(0));
  video.currentTime = buffer.buffered.start(0) + 0.1;
  await video.play();
}"""


def watch_status(context, worker):
    # Open the packaged toolbar in a background tab. Its normal message path
    # inspects the original active page and exposes only a coarse local status.
    popup_url = worker.evaluate("chrome.runtime.getURL('popup.html')")
    with context.expect_page() as new_page:
        worker.evaluate("url => chrome.tabs.create({url,active:false})", popup_url)
    return new_page.value


def start_trace(worker):
    # Test-only worker instrumentation records lifecycle and sample counts. Media
    # bytes, URLs and model scores are deliberately omitted.
    worker.evaluate("""() => {
      globalThis.socialTrace = [];
      chrome.runtime.onMessage.addListener(m => {
        if (m?.kind === 'video' || m?.type === 'label-ai:cancel') {
          const trace = globalThis.socialTrace;
          trace.push([m.type, m.scope ?? 'whole', (m.frames ?? []).length, m.durationMs ?? 0]);
          if (trace.length > 32) trace.shift();
        }
      });
    }""")


def wait_on_player(page, selector, popup, worker):
    try:
        wait_for_video_badge(page, selector)
    finally:
        print("Recent video requests:", worker.evaluate("globalThis.socialTrace ?? []"), flush=True)
        print("Last toolbar status:", popup.locator('[role=status]').inner_text(timeout=5000), flush=True)
        print("Player at check:", page.locator(selector).evaluate("""v => ({
          duration: Number.isFinite(v.duration) ? v.duration : 'stream',
          sourceType: v.srcObject?.constructor?.name || v.currentSrc.split(':')[0],
          pixels: (() => {try { const c=document.createElement('canvas'); c.width=c.height=1;
            const g=c.getContext('2d'); g.drawImage(v,0,0,1,1); g.getImageData(0,0,1,1);
            return 'readable'; } catch(e) {return e.name;} })(),
          chain: (() => {const chain=[];for(let e=v;e;e=e.parentElement){const s=getComputedStyle(e);
            const r=e.getBoundingClientRect();chain.push([e.tagName,s.display,s.visibility,s.opacity,
            [r.x,r.y,r.width,r.height].map(Math.round)]);} return chain;})(),
          stack: (()=>{const r=v.getBoundingClientRect(); return document.elementsFromPoint(
            Math.max(0,r.left)+Math.min(innerWidth,r.width)/2,Math.max(0,r.top)+Math.min(innerHeight,r.height)/2
          ).slice(0,8).map(e=>e.tagName)})(),
          time: v.currentTime, finite: Number.isFinite(v.duration), paused: v.paused,
          ready: v.readyState, frames: v.getVideoPlaybackQuality().totalVideoFrames,
          decision: document.documentElement.dataset.videoTestDecision,
          badgeCount: Array.from(document.querySelectorAll('label-ai-overlay'))
            .reduce((n,e)=>n+(e.shadowRoot?.querySelectorAll('.slop-label').length??0),0)
        })"""), flush=True)


def stream_test(context, worker, folder):
    generated = fixture(ROOT / "artifacts/social-video" / GENERATED,
                        SHOWCASE + "video/" + GENERATED, GENERATED_HASH)
    camera = fixture(ROOT / "artifacts/video-smoke/flower.mp4", MDN + "flower.mp4", FILES["flower.mp4"])
    responses = {
        "/watch": ("text/html", '<!doctype html><title>Feed</title><link rel="icon" href="data:,">'
                   '<video width="500" height="320" muted controls playsinline></video>'),
        "/1.mp4": ("video/mp4", make_segment(generated, folder)),
        "/2.mp4": ("video/mp4", make_segment(camera, folder)),
    }
    unexpected = []
    def serve(route):
        path = route.request.url.removeprefix(PAGE)
        if route.request.method == "GET" and path in responses:
            mime, body = responses[path]
            return route.fulfill(content_type=mime, body=body)
        unexpected.append((route.request.method, route.request.url))
        return route.abort()
    context.route("http*/**", serve)
    page = context.new_page()
    page.bring_to_front()
    page.goto(PAGE + "/watch")
    page.locator("label-ai-overlay").wait_for(state="attached")
    observe_decisions(worker)
    video = page.locator("video")
    popup = watch_status(context, worker)
    page.bring_to_front()
    for index in (1, 2):
        page.evaluate("delete document.documentElement.dataset.videoTestDecision")
        page.evaluate(START_STREAM, f"/{index}.mp4")
        assert video.evaluate("v => v.currentSrc.startsWith('blob:') && v.duration === Infinity && v.currentTime >= 70")
        if index == 1:
            wait_on_player(page, "video", popup, worker)
            print("Generated footage labeled on a playing MediaSource joined at 70s", flush=True)
        else:
            page.locator("label-ai-overlay .slop-label").wait_for(state="detached", timeout=12_000)
            page.wait_for_function("document.documentElement.dataset.videoTestDecision === 'negative'", timeout=60_000)
            assert video.evaluate("v => v.currentTime > 73")
            assert not page.locator("label-ai-overlay .slop-label").count()
            print("Recycled player removed badge and completed a camera-footage scan", flush=True)
    assert not unexpected, unexpected


SELECT_PLAYER = """platform => {
  const visible = v => {
    const b = v.getBoundingClientRect();
    return b.width > 160 && b.height > 90 && b.top < innerHeight && b.bottom > 0 &&
      b.left < innerWidth && b.right > 0 && v.readyState >= 2 && v.videoWidth > 0;
  };
  let player;
  if (platform === 'youtube') {
    const box = document.querySelector('#movie_player');
    if (box?.getVideoData?.().video_id !== 'Itbc12qXr30' || box.classList.contains('ad-showing')) return false;
    player = [...box.querySelectorAll('video')].find(visible);
  } else if (platform === 'bluesky') {
    if (!location.pathname.endsWith('/3m23sq2iios2g')) return false;
    const post = [...document.querySelectorAll('[data-testid="postThreadItem-by-carnage4life.bsky.social"]')]
      .find(el => el.innerText.includes('OpenAI launched Sora 2 today'));
    player = [...(post?.querySelectorAll('video') ?? [])].find(visible);
  } else {
    if (!location.pathname.endsWith('/7508418787968830742')) return false;
    const players = [...document.querySelectorAll('video')].filter(visible);
    if (players.length === 1) player = players[0];
  }
  if (!player) return false;
  player.dataset.labelTestPlayback = '1';
  return true;
}"""


def live_test(context, worker, platform):
    url = PERMALINKS[platform]
    page = context.new_page()
    page.bring_to_front()
    response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    print(f"{platform} guest permalink HTTP {response.status if response else 'unknown'}", flush=True)
    selector = 'video[data-label-test-playback="1"]'
    try:
        if platform == "bluesky":
            post = page.get_by_test_id("postThreadItem-by-carnage4life.bsky.social").filter(
                has_text="OpenAI launched Sora 2 today").first
            post.wait_for(timeout=25_000)
            post.scroll_into_view_if_needed()
            play = post.get_by_role("button", name=re.compile(r"^play(?: video)?$", re.IGNORECASE)).first
            if play.is_visible():
                play.click()
        page.wait_for_function(SELECT_PLAYER, arg=platform, timeout=35_000)
        target = page.locator(selector)
        target.evaluate("v => { v.muted = true; return v.play(); }", timeout=10_000)
        first = target.evaluate("v => v.getVideoPlaybackQuality().totalVideoFrames")
        page.wait_for_function("""start => {
          const v = document.querySelector('video[data-label-test-playback="1"]');
          return v && !v.paused && v.getVideoPlaybackQuality().totalVideoFrames > start + 2;
        }""", arg=first, timeout=18_000)
    except BrowserError as exc:
        # Show only the public page's visible message, never browser cookies or media URLs.
        message = page.locator("body").inner_text(timeout=2000)
        raise RuntimeError(f"{platform}: guest playback unverified; page says {message[:450]!r}") from exc
    print(f"{platform}: verified visible moving frames on the target video", flush=True)
    popup = watch_status(context, worker)
    page.bring_to_front()
    wait_on_player(page, selector, popup, worker)
    assert page.evaluate(SELECT_PLAYER, platform)
    print(f"{platform}: production badge verified on the playing guest video at {url}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--browser")
    parser.add_argument("--live", choices=PERMALINKS)
    args = parser.parse_args()
    build = args.build.resolve()
    launch = [f"--disable-extensions-except={build}", f"--load-extension={build}",
              "--disable-component-update", "--disable-background-networking", "--disable-sync"]
    with TemporaryDirectory() as profile, TemporaryDirectory() as folder, sync_playwright() as pw:
        with browser_session(pw, profile, launch, args) as context:
            worker = wait_for_registration(context, build)
            start_trace(worker)
            if args.live:
                live_test(context, worker, args.live)
            else:
                stream_test(context, worker, Path(folder))
