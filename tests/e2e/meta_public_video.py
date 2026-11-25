"""Verify public Facebook and Instagram reels with the site's ordinary playback UI."""
from contextlib import contextmanager


# CyberPeace matched these frames and documented the AI-content disclosure on
# this specific Powarstar Sumit Pathak reel:
# https://cyberpeace.org/resources/blogs/factcheck-ai-generated-video-falsely-shared-as-cctv-footage-of-bull-saving-young-man
# Lead Stories traced this polar-bear clip to @anton.yehorov and documented
# the creator's own disclosure under "About this reel":
# https://leadstories.com/hoax-alert/2026/10/fact-check-fake-video-of-man-who-rescues-raises-releases-injured-polar-bear-cub.html
META_POSTS = {
    "facebook": {"site": "facebook", "id": "1473526454600527", "author": "sumit pathak"},
    "instagram": {"site": "instagram", "id": "DexOm8xRMCb", "author": "anton.yehorov"},
}
META_PERMALINKS = {site: f"https://www.{site}.com/reel/{post['id']}/" for site, post in META_POSTS.items()}
PLAYER = 'video[data-label-test-playback="1"]'

IS_TARGET_POST = """(post, url) => {
  let u;
  try { u = new URL(url); } catch { return false; }
  const domain = post.site + '.com';
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      ![domain, 'www.' + domain].includes(u.hostname)) return false;
  const parts = u.pathname.replace(/^\\/|\\/$/g, '').split('/');
  if (post.site === 'facebook' && parts.length === 1 && parts[0] === 'watch') {
    const ids = u.searchParams.getAll('v');
    return ids.length === 1 && ids[0] === post.id;
  }
  if (post.site === 'instagram' && parts.length === 3 && parts[0].toLowerCase() === post.author) parts.shift();
  const types = post.site === 'facebook' ? ['reel'] : ['reel', 'reels', 'p'];
  return parts.length === 2 && types.includes(parts[0]) && parts[1] === post.id;
}"""

# Bind the player to the specific post, even when recommendations share the
# page. Match a permalink or creator inside a single-video region. Never use
# this text as evidence for classification.
POST_REGION = r"""(element, post, matches) => {
  for (let region=element.parentElement; region && region!==document.body; region=region.parentElement) {
    if (region.querySelectorAll('video').length > 1 ||
        region.querySelectorAll('article,[role=article]').length > 1) return null;
    const links = [...region.querySelectorAll('a[href]')];
    const competing = links.some(a => /\/reels?\/[^/]+|\/watch\/?$/i.test(a.pathname) && !matches(a.href));
    if (competing) return null;
    if (links.some(a => matches(a.href)) || region.innerText?.toLowerCase().includes(post.author)) return region;
    if (region.matches('article,[role=article]')) return null;
  }
  return null;
}"""
BUTTON_POINT = """button => {
  if (!button.checkVisibility({opacityProperty:true, visibilityProperty:true})) return null;
  const r=button.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  return r.width && r.height && x>=0 && y>=0 && x<innerWidth && y<innerHeight &&
    button.contains(document.elementFromPoint(x,y)) ? [x,y] : null;
}"""

TARGET_PLAYER = """(post, checking) => {
  const matches = (url) => (""" + IS_TARGET_POST + """)(post, url);
  if (!matches(location.href)) return null;
  const showing = el => el.checkVisibility({opacityProperty:true, visibilityProperty:true});
  const videos = [...document.querySelectorAll('video')];
  const candidates = [];
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const left = Math.max(0,r.left), top = Math.max(0,r.top);
    const width = Math.min(innerWidth,r.right)-left, height = Math.min(innerHeight,r.bottom)-top;
    if (width < 160 || height < 90 || !showing(v)) continue;
    const region = (""" + POST_REGION + """)(v, post, matches);
    if (!region) continue;
    // A login dialog or an opaque cover can leave a hidden decoder playing.
    // Require the player or an actual player control to be hit at its center.
    const x = left + width/2, y = top + height/2;
    const hit = document.elementFromPoint(x,y);
    const action = hit?.closest('button,[role=button]');
    const actionName = (action?.getAttribute('aria-label') || action?.innerText || '').trim();
    let surface = v.parentElement;
    while (surface && surface !== region && !surface.contains(hit)) {
      surface = surface.parentElement;
    }
    if (!hit || !surface || !surface.contains(hit) || hit.closest('a[href],input') ||
        hit.closest('[aria-modal=true],[role=dialog]') !== v.closest('[aria-modal=true],[role=dialog]')) continue;
    const box = surface.getBoundingClientRect();
    if (action && actionName && !/^(play|pause)( video)?$/i.test(actionName)) continue;
    if (hit !== v && !(action && /^(play|pause)( video)?$/i.test(actionName)) &&
        (box.width > r.width*1.35 || box.height > r.height*1.35 || hit.matches('img,canvas'))) continue;
    if (checking && (!v.dataset.labelTestPlayback || v[Symbol.for('label-ai-test-source')] !== v.currentSrc ||
                     v.readyState < 2 || !v.videoWidth)) continue;
    candidates.push(v);
  }
  return candidates.length === 1 ? candidates[0] : null;
}"""

START_PLAYER = """post => {
  const v = (""" + TARGET_PLAYER + """)(post, false);
  if (!v) return false;
  v.dataset.labelTestPlayback = '1';
  return true;
}"""

# Both sites may offer public playback behind an optional account prompt.
# Respect a mandatory sign-in. Only use a prompt's own visible Close control.
OPTIONAL_CLOSE = """() => {
  for (const dialog of document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')) {
    const heading = dialog.querySelector('h1,h2,[role=heading]');
    const title = heading?.textContent || dialog.getAttribute('aria-label') || '';
    const account = /(?:log ?in|sign in|see more) (?:to|on) (?:facebook|instagram)/i.test(title);
    const cookies = /cookies?/i.test(title);
    for (const button of dialog.querySelectorAll('button,[role=button]')) {
      const label = (button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim();
      const refusal = /^(?:(?:decline|reject|refuse) (?:optional cookies|non-essential cookies|all(?: cookies)?)|(?:only allow|allow only) essential cookies|allow essential cookies only)$/i;
      if (!(account && /^(?:close|not now)$/i.test(label)) && !(cookies && refusal.test(label))) continue;
      const point = (""" + BUTTON_POINT + """)(button);
      if (point) return {kind: cookies ? 'decline-optional-cookies' : 'close-account-prompt', point};
    }
  }
  return null;
}"""

# Some public viewers instantiate their video only after Play is pressed.
# Require a single visible play button owned by the exact target reel.
POST_PLAY = """post => {
  const matches = url => (""" + IS_TARGET_POST + """)(post, url);
  if (!matches(location.href)) return null;
  const points = [];
  for (const button of document.querySelectorAll('button,[role=button]')) {
    const label = (button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim();
    if (!/^(?:play|play video|play reel|play video reel)$/i.test(label)) continue;
    if (!(""" + POST_REGION + """)(button, post, matches)) continue;
    const point = (""" + BUTTON_POINT + """)(button);
    if (point) points.push(point);
  }
  return points.length===1 ? points[0] : null;
}"""
VIEWER_READY = """({post, used}) => {
  if (!(""" + IS_TARGET_POST + """)(post,location.href)) return false;
  const prompt = (""" + OPTIONAL_CLOSE + """)();
  if (prompt) return used.includes(prompt.kind) ? false : prompt;
  if ((""" + START_PLAYER + """)(post)) return true;
  const point = !used.includes('play') && (""" + POST_PLAY + """)(post);
  return point && {kind:'play',point};
}"""

# Public CI logs must contain only coarse counts and fixed gate categories;
# the same code also runs in an interactive signed-in temporary profile.
DIAGNOSTICS = r"""post => {
  const visible = e => e.checkVisibility({opacityProperty:true, visibilityProperty:true});
  const body = document.body?.innerText || '';
  const title = document.title || '';
  const videos = [...document.querySelectorAll('video')];
  const large = videos.filter(v => {
    const r=v.getBoundingClientRect();
    return visible(v) && Math.min(innerWidth,r.right)-Math.max(0,r.left)>=160 &&
      Math.min(innerHeight,r.bottom)-Math.max(0,r.top)>=90;
  });
  const matches = url => (""" + IS_TARGET_POST + r""")(post,url);
  const gate = /security check|confirm you.re human|not a bot|unusual traffic/i.test(body) ? 'verification' :
    /(?:isn.t|is not|no longer) available|private (?:post|video|account)|content unavailable|couldn.t find this page/i.test(body) ? 'unavailable-or-private' :
    /log ?in to (?:watch|continue|see)|you must log in|log in to facebook|login . instagram/i.test(body+' '+title) ? 'sign-in' :
    /temporarily blocked|try again later|something went wrong/i.test(body) ? 'temporarily-unavailable' : 'none-observed';
  return {
    expectedRoute:matches(location.href), accountRoute:/\/(?:accounts\/login|login|checkpoint)(?:\/|$)/i.test(location.pathname),
    gate, passwordField:[...document.querySelectorAll('input[type=password]')].some(visible),
    optionalPrompt:((""" + OPTIONAL_CLOSE + """)()?.kind || 'none'),
    iframes:document.querySelectorAll('iframe').length, videos:videos.length, inViewport:large.length,
    decoded:large.filter(v=>v.readyState>=2 && v.videoWidth>0).length,
    playing:large.filter(v=>!v.paused && !v.ended).length,
    presentedFrames:Math.max(0,...large.map(v=>v.getVideoPlaybackQuality?.().totalVideoFrames || 0)),
    primaryPostLink:[...document.querySelectorAll('a[href]')].some(a=>matches(a.href)),
    primaryAuthorText:body.toLowerCase().includes(post.author),
    targetBound:Boolean(document.querySelector('video[data-label-test-playback="1"]'))
  };
}"""

BIND_MOVING_PLAYER = """async post => {
  const v = (""" + TARGET_PLAYER + """)(post, false);
  if (!v || !v.dataset.labelTestPlayback || v.paused || v.readyState < 2 || !v.videoWidth) return false;
  const src = v.currentSrc;
  const first = await new Promise(resolve => v.requestVideoFrameCallback((_, frame) => resolve(frame)));
  const next = await new Promise(resolve => v.requestVideoFrameCallback((_, frame) => resolve(frame)));
  if (!v.isConnected || v.paused || !src || src !== v.currentSrc ||
      next.presentedFrames <= first.presentedFrames || next.mediaTime === first.mediaTime) return false;
  v[Symbol.for('label-ai-test-source')] = src;
  return true;
}"""

VERIFY_PLAYER = """post => {
  const v = (""" + TARGET_PLAYER + """)(post, true);
  return Boolean(v && !v.paused);
}"""


@contextmanager
def optional_diagnostics():
    """Diagnostic reads are best effort; never echo arbitrary browser error text."""
    try:
        yield
    except Exception:
        print("Some browser diagnostics were unavailable", flush=True)


MOTION_SURFACE = """v => {
  const visible = e => e.checkVisibility({opacityProperty:true,visibilityProperty:true});
  if (visible(v)) return v;
  const post = v.closest('article,[role=article]');
  if (!post || !v.videoWidth || !v.videoHeight) return null;
  const r = v.getBoundingClientRect();
  const aligned = [...post.querySelectorAll('canvas')].filter(c => {
    const b = c.getBoundingClientRect();
    return visible(c) && c.height && Math.abs(c.width/c.height/(v.videoWidth/v.videoHeight)-1)<=0.05 &&
      ['left','right','top','bottom'].every(key => Math.abs(b[key]-r[key])<=2);
  });
  return aligned.length === 1 ? aligned[0] : null;
}"""
MOTION_SAMPLE = """(v, initial) => {
  const screen = initial.surface;
  if (!screen || !v.isConnected || !screen.isConnected || !v.videoWidth || !(v.currentSrc || v.srcObject) ||
      v.currentSrc !== initial.src || v.srcObject !== initial.stream || location.href !== initial.page ||
      v.paused || v.ended || v.seeking || v.readyState < 2 || (""" + MOTION_SURFACE + """)(v) !== screen) return null;
  const visible = e => e.checkVisibility({opacityProperty:true,visibilityProperty:true});
  if ([...document.querySelectorAll('input[type=password]')].some(visible)) return null;
  const r = screen.getBoundingClientRect();
  const left = Math.max(0,r.left), top = Math.max(0,r.top);
  const width = Math.min(innerWidth,r.right)-left, height = Math.min(innerHeight,r.bottom)-top;
  if (width < 160 || height < 90) return null;
  const accessible = (x,y) => {
    const hit = document.elementFromPoint(x,y);
    if (!hit || hit === document.body || hit === document.documentElement ||
        hit.closest('input,textarea,form,iframe,button,a[href],[role=button]') ||
        hit.closest('[role=dialog],dialog') !== screen.closest('[role=dialog],dialog')) return false;
    if (hit === screen) return true;
    // A same-size player wrapper can receive pointer events over its media.
    for (let box=screen.parentElement; box && box!==document.body; box=box.parentElement) {
      const b=box.getBoundingClientRect();
      if (['left','right','top','bottom'].every(key=>Math.abs(b[key]-r[key])<=2) && box.contains(hit)) {
        const style=getComputedStyle(hit);
        if (hit===box || (!hit.matches('img,canvas,video,svg') && style.backgroundImage==='none' &&
            style.backgroundColor==='rgba(0, 0, 0, 0)')) return true;
      }
      if (box.matches('article,[role=article]')) break;
    }
    return false;
  };
  const clips = [];
  for (const [fx,fy] of [[0.35,0.4],[0.65,0.6]]) {
    const x=Math.floor(left+width*fx), y=Math.floor(top+height*fy);
    if (![[0,0],[-15,-15],[15,15],[-15,15],[15,-15]].every(([dx,dy])=>accessible(x+dx,y+dy))) continue;
    clips.push({x:x+scrollX-16,y:y+scrollY-16,width:32,height:32});
  }
  const quality=v.getVideoPlaybackQuality();
  return clips.length ? {clips, frames:quality.totalVideoFrames-quality.droppedVideoFrames, time:v.currentTime} : null;
}"""


def check_visible_motion(page, player):
    """Require repeated visible motion on a stable surface and advancing presentation."""
    bound = player.element_handle(timeout=2000)
    if bound is None:
        raise AssertionError("Target video was removed")
    initial = bound.evaluate_handle("v => ({surface:(" + MOTION_SURFACE +
                                    ")(v), src:v.currentSrc, stream:v.srcObject, page:location.href})")
    try:
        previous = None
        previous_pixels = []
        consecutive = 0
        for index in range(7):
            if index:
                page.wait_for_timeout(300)
            sample = bound.evaluate(MOTION_SAMPLE, initial)
            if not sample:
                raise AssertionError("The public player has no bound unobstructed playback surface")
            pixels = [page.screenshot(clip=clip, timeout=2000) for clip in sample["clips"]]
            advancing = (previous and previous["clips"] == sample["clips"] and
                         sample["frames"] > previous["frames"] and sample["time"] > previous["time"])
            consecutive = consecutive + 1 if advancing and pixels != previous_pixels else 0
            if consecutive >= 2:
                return
            previous, previous_pixels = sample, pixels
        raise AssertionError("The visible player did not change across two advancing presentation intervals")
    finally:
        with optional_diagnostics():
            initial.dispose()
            bound.dispose()


def prepare_meta_player(page, platform):
    """Return the creator-bound player only after presentation of moving frames."""
    post = META_POSTS[platform]
    try:
        return _play_meta_post(page, platform, post)
    except Exception:
        with optional_diagnostics():
            if not page.is_closed():
                print(f"{platform}: public viewer state {page.evaluate(DIAGNOSTICS, post)}", flush=True)
        raise


def _play_meta_post(page, platform, post):
    used = []
    while True:
        ready = page.wait_for_function(VIEWER_READY, arg={"post": post, "used": used}, timeout=35_000)
        action = ready.json_value()
        ready.dispose()
        if action is True:
            break
        used.append(action["kind"])
        page.mouse.click(*action["point"])
        print(f"{platform}: used public viewer control {action['kind']}", flush=True)
    player = page.locator(PLAYER)
    if player.evaluate("v => v.paused"):
        center = page.evaluate(POST_PLAY, post) or player.evaluate("""v => {
          const r = v.getBoundingClientRect();
          return [(Math.max(0,r.left) + Math.min(innerWidth,r.right))/2,
                  (Math.max(0,r.top) + Math.min(innerHeight,r.bottom))/2];
        }""")
        page.mouse.click(*center)
    page.wait_for_function(BIND_MOVING_PLAYER, arg=post, timeout=20_000)
    check_visible_motion(page, player)
    return player


def verify_meta_player(page, platform, player):
    """Reject a replaced post/player or one hidden while the verdict was pending."""
    if player.count() != 1 or not page.evaluate(VERIFY_PLAYER, META_POSTS[platform]):
        raise AssertionError(f"{platform} changed or obscured the target reel during analysis")
