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
          pixels: (() => {try { if (!v.checkVisibility({opacityProperty:true,visibilityProperty:true}))
              return 'not tested (hidden element)'; const c=document.createElement('canvas'); c.width=c.height=1;
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


def stream_test(context, worker, folder, canvas_player=False):
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
    if canvas_player:
        page.evaluate("""() => {
          const v = document.querySelector('video'), card = document.createElement('section');
          card.style.cssText = 'position:relative;width:500px;height:320px';
          v.before(card);
          card.append(v);
          v.style.opacity = '0';
          const screen = document.createElement('canvas');
          screen.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
          card.append(screen);
          function draw() {
            if (v.videoWidth && v.readyState >= 2) {
              if(screen.width !== v.videoWidth || screen.height !== v.videoHeight) {
                screen.width=v.videoWidth; screen.height=v.videoHeight;
              }
              screen.getContext('2d').drawImage(v,0,0);
            }
            v.requestVideoFrameCallback(draw);
          }
          v.requestVideoFrameCallback(draw);
        }""")
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


def play_tiktok(page, target):
    # A decoder can advance underneath the cover. Use a real user gesture over
    # this permalink's player and let the site switch its own rendering layers.
    point = target.evaluate("""v => {
      const r=v.getBoundingClientRect();
      const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2;
      const y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
      const hit=document.elementFromPoint(x,y);
      if (!hit || hit.closest('a[href], input, dialog, [role=dialog]')) return null;
      for (let box=v;box && box!==document.body;box=box.parentElement) {
        const b=box.getBoundingClientRect();
        if (!box.contains(hit) || b.width>1.8*r.width || b.height>1.8*r.height ||
            b.width<1 || b.height<1) continue;
        // Prefer an unobscured actual play control, otherwise click the image
        // area that a viewer uses to start/pause the focused post.
        for (const c of box.querySelectorAll('[data-e2e="video-play"],button[aria-label="Play"],[role=button][aria-label="Play video"]')) {
          const a=c.getBoundingClientRect(), px=a.left+a.width/2, py=a.top+a.height/2;
          if (a.width && a.height && px>=r.left && px<r.right && py>=r.top && py<r.bottom &&
              c.contains(document.elementFromPoint(px,py))) return [px,py];
        }
        return [x,y];
      }
      return null;
    }""")
    try:
        if point is None:
            raise RuntimeError("TikTok's player is covered or has no visible playback control")
        for _ in range(2):
            page.mouse.click(*point)
            # Clicking an autoplaying clip can pause it. Click again only if its
            # own decoder reports a pause and the page is still on this post.
            try:
                page.wait_for_function("""() => {
                  const v=document.querySelector('video[data-label-test-playback="1"]');
                  return v && !v.paused && v.checkVisibility({opacityProperty:true,visibilityProperty:true});
                }""", timeout=3500)
                break
            except BrowserError:
                if not target.evaluate("v => location.pathname.endsWith('/7508418787968830742') && v.paused"):
                    break
    finally:
        surface = target.evaluate("""v => {
          const r=v.getBoundingClientRect();
          const visible=e=>e.checkVisibility({opacityProperty:true,visibilityProperty:true});
          const overlaps=e=>{const b=e.getBoundingClientRect();return (
            Math.max(0,Math.min(b.right,r.right)-Math.max(b.left,r.left))*
            Math.max(0,Math.min(b.bottom,r.bottom)-Math.max(b.top,r.top)) > .7*r.width*r.height)};
          const canvases=[...document.querySelectorAll('canvas')];
          const layers=[...document.elementsFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)]
            .filter(e=>visible(e)&&overlaps(e)).slice(0,8).map(e=>e.tagName);
          return {visibleVideo:visible(v), canvasCount:canvases.length,
            matchingCanvases:canvases.filter(e=>visible(e)&&overlaps(e)).map(c=>[c.width,c.height]).slice(0,6),layers};
        }""")
        print("TikTok render surface after viewer click:", surface, flush=True)
    if not surface["visibleVideo"] and not surface["matchingCanvases"]:
        raise RuntimeError("TikTok did not expose a visible video or overlapping canvas after the viewer click")



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
        if platform == "tiktok":
            play_tiktok(page, target)
        else:
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
    parser.add_argument("--canvas-player", action="store_true")
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
                stream_test(context, worker, Path(folder), args.canvas_player)
