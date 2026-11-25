"""Verify public Facebook and Instagram reels with the site's ordinary playback UI."""

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
    let region = v.parentElement;
    while (region && region !== document.body) {
      if (region.querySelectorAll('video').length !== 1) break;
      if (region.innerText?.toLowerCase().includes(post.author) ||
          [...region.querySelectorAll('a[href]')].some(a => matches(a.href))) break;
      region = region.parentElement;
    }
    if (!region || region === document.body || region.querySelectorAll('video').length !== 1) continue;
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
  for (const dialog of document.querySelectorAll('[role=dialog],dialog[open]')) {
    const heading = dialog.querySelector('h1,h2,[role=heading]');
    const title = heading?.textContent || dialog.getAttribute('aria-label') || '';
    if (!/(?:log ?in|sign in|see more) (?:to|on) (?:facebook|instagram)/i.test(title)) continue;
    for (const button of dialog.querySelectorAll('button,[role=button]')) {
      const label = button.getAttribute('aria-label') || button.innerText || '';
      if (!/^(?:close|not now)$/i.test(label.trim()) ||
          !button.checkVisibility({opacityProperty:true,visibilityProperty:true})) continue;
      const r = button.getBoundingClientRect();
      const x = r.x + r.width/2, y = r.y + r.height/2;
      if (r.width && r.height && x>=0 && y>=0 && x<innerWidth && y<innerHeight &&
          button.contains(document.elementFromPoint(x,y))) return [x,y];
    }
  }
  return null;
}"""
VIEWER_READY = """post => {
  const close = (""" + OPTIONAL_CLOSE + """)();
  if (close) return close;
  return (""" + START_PLAYER + """)(post);
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


def check_visible_motion(page, player):
    # Decoder callbacks can advance underneath a cover. Sample the interior
    # actually seen by the viewer, away from the controls and label. The test
    # keeps these pixels in memory and writes no screenshots.
    clips = player.evaluate("""v => {
      const r = v.getBoundingClientRect();
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const width = Math.min(innerWidth, r.right) - left, height = Math.min(innerHeight, r.bottom) - top;
      return [[0.35,0.4],[0.65,0.6]].map(([fx,fy]) => ({
        x:scrollX+left+Math.floor(width*fx)-16, y:scrollY+top+Math.floor(height*fy)-16, width:32, height:32
      }));
    }""")
    baseline = [page.screenshot(clip=clip) for clip in clips]
    for _ in range(6):
        page.wait_for_timeout(300)
        if any(page.screenshot(clip=clip) != previous for clip, previous in zip(clips, baseline)):
            return
    raise AssertionError("The public reel presented decoder frames but its visible surface did not move")


def prepare_meta_player(page, platform):
    """Return the creator-bound player only after presentation of moving frames."""
    post = META_POSTS[platform]
    ready = page.wait_for_function(VIEWER_READY, arg=post, timeout=35_000)
    value = ready.json_value()
    ready.dispose()
    if isinstance(value, list):
        page.mouse.click(*value)
        page.wait_for_function(START_PLAYER, arg=post, timeout=20_000)
    player = page.locator(PLAYER)
    if player.evaluate("v => v.paused"):
        center = player.evaluate("""v => {
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
