"""Recognize a public TikTok viewer and its ordinary optional account prompt."""
from time import monotonic

from meta_public_video import BUTTON_POINT, check_visible_motion

VIEWER_STATE = r"""(v, expected) => {
  const post=new URL(expected);
  if (location.origin!==post.origin || location.pathname!==post.pathname) return {kind:'other-post'};
  const showing=e=>e.checkVisibility({opacityProperty:true,visibilityProperty:true});
  for (const dialog of document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true]')) {
    if (!showing(dialog)) continue;
    const heading=dialog.querySelector('h1,h2,[role=heading]');
    const title=(heading?.textContent || dialog.getAttribute('aria-label') || '').trim();
    if (!/^(?:(?:log in|sign in|sign up)(?: or (?:sign up|log in))?(?: to (?:use )?tiktok)?|join tiktok)(?:[!.]|$)/i.test(title)) continue;
    for (const button of dialog.querySelectorAll('button,[role=button]')) {
      const label=(button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim();
      if (!/^(?:not now|close(?: dialog)?)$/i.test(label)) continue;
      const point=(""" + BUTTON_POINT + r""")(button);
      if (point) return {kind:'dismiss',point};
    }
    return {kind:'account'};
  }
  const r=v.getBoundingClientRect(), x=(Math.max(r.left,0)+Math.min(innerWidth,r.right))/2,
        y=(Math.max(r.top,0)+Math.min(innerHeight,r.bottom))/2;
  const hit=document.elementFromPoint(x,y);
  if (hit && hit!==v && !hit.contains(v) && !hit.matches('canvas,video,img')) {
    const b=hit.getBoundingClientRect(), style=getComputedStyle(hit);
    const color=style.backgroundColor.match(/^rgba?\(([^)]+)\)$/);
    const channels=color?.[1].split(',').map(Number);
    if (channels && channels.slice(0,3).every(n=>n<=25) &&
        (channels[3]??1) * Number(style.opacity || 1)>=0.5 &&
        b.width>=r.width*0.85 && b.height>=r.height*0.85) return {kind:'scrim'};
  }
  return {kind:'clear'};
}"""


def inspect_viewer(page, target, url, can_dismiss):
    state = target.evaluate(VIEWER_STATE, url, timeout=2000)
    if state["kind"] == "other-post":
        raise RuntimeError("TikTok left the target public post")
    if state["kind"] == "dismiss" and can_dismiss:
        page.mouse.click(*state["point"])
        print("TikTok: dismissed its optional account prompt", flush=True)
    return state["kind"]


def wait_on_tiktok(page, selector, url, wait_for_badge, timeout_error):
    target = page.locator(selector)
    deadline = monotonic() + 100
    dismissed = False
    while monotonic() < deadline:
        state = inspect_viewer(page, target, url, not dismissed)
        dismissed |= state == "dismiss"
        if state != "clear":
            page.wait_for_timeout(500)
            continue
        try:
            wait_for_badge(page, selector, timeout=1500)
        except timeout_error:
            continue
        # The page may show its account prompt during classification. Prove
        # that the badge is still on the moving player after any dismissal.
        if inspect_viewer(page, target, url, False) == "clear":
            try:
                check_visible_motion(page, target)
                wait_for_badge(page, selector, timeout=1500)
            except AssertionError:
                if inspect_viewer(page, target, url, False) == "clear":
                    raise
                continue
            except timeout_error:
                continue
            return
    state = inspect_viewer(page, target, url, False)
    if state != "clear":
        raise RuntimeError(f"TikTok obscured playback with an interstitial ({state}); no visible badge verification")
    raise RuntimeError("TikTok's public player did not display its video badge before timeout")
