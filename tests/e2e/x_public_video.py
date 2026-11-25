"""Bind the public X acceptance check to OpenAI's original Sora video."""
from urllib.parse import urlsplit

X_POST_PATH = "/OpenAI/status/1758192957386342435"
X_POST_URL = "https://x.com" + X_POST_PATH
POST = (
    'article[data-testid="tweet"]'
    f':has(a[href="{X_POST_PATH}" i] time)'
)
CAPTION = '[data-testid="tweetText"]'
PLAYER = '[data-testid="videoPlayer"]'
MARKED = 'video[data-label-test-x-playback="1"]'


def is_expected_x_post(url):
    location = urlsplit(url)
    path = location.path.rstrip("/").lower()
    return (location.scheme == "https" and location.netloc.lower() in {"x.com", "www.x.com"}
            and path in {X_POST_PATH.lower(), X_POST_PATH.lower() + "/video/1"})


# Verify the video's owner independently from the tab URL. X renders replies,
# related posts and quoted attachments in the same document.
BOUND = """(video, {post, path, caption, player}) => {
  const owner = video.closest('article');
  if (!owner?.matches(post) || !video.closest(player) ||
      video.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"]')) return false;
  const own = element => element.closest('article') === owner &&
    !element.closest('[data-testid="quoteTweet"],[data-testid="card.wrapper"]');
  if (![...owner.querySelectorAll('a[href] time')].some(time =>
      own(time) && time.closest('a').pathname.toLowerCase() === path.toLowerCase())) return false;
  if (![...owner.querySelectorAll(caption)].some(el =>
      own(el) && el.textContent.includes('Introducing Sora'))) return false;
  const r = video.getBoundingClientRect();
  return video.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
    Math.min(innerWidth, r.right) - Math.max(0, r.left) >= 160 &&
    Math.min(innerHeight, r.bottom) - Math.max(0, r.top) >= 90;
}"""
BINDING = {"post": POST, "path": X_POST_PATH, "caption": CAPTION, "player": PLAYER}


def assert_x_post(page, selector):
    """Reject navigation, media replacement or a hidden player while awaiting a verdict."""
    if not is_expected_x_post(page.url):
        raise AssertionError("X left the expected OpenAI post")
    video = page.locator(selector)
    if video.count() != 1 or not video.evaluate(BOUND, BINDING):
        raise AssertionError("The visible X player no longer belongs to the expected post")
    if not video.evaluate("v => Boolean(v.currentSrc) && v.currentSrc === v.dataset.labelTestXSource"):
        raise AssertionError("X changed the media source while awaiting the badge")


def prepare_x_playback(page):
    """Use the post's own controls and require multiple advancing presented frames."""
    if not is_expected_x_post(page.url):
        raise AssertionError("X redirected away from the expected OpenAI post")
    post = page.locator(POST).filter(has_text="Introducing Sora")
    post.wait_for(state="visible", timeout=30_000)
    player = post.locator(PLAYER)
    player.scroll_into_view_if_needed(timeout=12_000)
    video = player.locator("video")
    if not video.count() or video.evaluate("v => v.paused"):
        controls = player.locator(
            '[data-testid="playButton"]:visible, button[aria-label="Play" i]:visible,'
            '[role="button"][aria-label="Play video" i]:visible'
        )
        if controls.count():
            controls.first.click(timeout=8000)
        else:
            # The publisher may render a native player without a play button.
            video.wait_for(state="visible", timeout=8000)
            if video.evaluate("v => v.paused"):
                video.click(timeout=8000)
    video.wait_for(state="visible", timeout=10_000)
    if not video.evaluate(BOUND, BINDING):
        raise AssertionError("X did not expose the visible primary video on OpenAI's post")
    advancing = video.evaluate("""video => new Promise(resolve => {
      let first, callback;
      const timeout = setTimeout(() => {
        video.cancelVideoFrameCallback(callback);
        resolve(false);
      }, 12000);
      const frame = (_, metadata) => {
        first ??= metadata;
        if (metadata.presentedFrames >= first.presentedFrames + 2 &&
            metadata.mediaTime >= first.mediaTime + 0.1 && !video.paused && video.videoWidth > 0) {
          clearTimeout(timeout);
          video.dataset.labelTestXPlayback = '1';
          video.dataset.labelTestXSource = video.currentSrc;
          resolve(true);
        } else {
          callback = video.requestVideoFrameCallback(frame);
        }
      };
      callback = video.requestVideoFrameCallback(frame);
    })""")
    if not advancing:
        raise AssertionError("X exposed the post but never presented advancing video frames")
    assert_x_post(page, MARKED)
    return MARKED
