"""Exercise the exact same permalink predicate used by the installed-browser checks."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from meta_public_video import IS_TARGET_POST, META_POSTS, META_PERMALINKS, TARGET_PLAYER, OPTIONAL_CLOSE, POST_PLAY, DIAGNOSTICS


class MetaPostIdentityTest(unittest.TestCase):
    def matches(self, platform, *urls):
        args = json.dumps([META_POSTS[platform], urls])
        program = f"const match = {IS_TARGET_POST}; const [post, urls] = {args}; " \
                  "console.log(JSON.stringify(urls.map(url => match(post, url))));"
        return json.loads(subprocess.check_output(["node", "-e", program], text=True))

    def test_matches_public_post_view_variants(self):
        fb = META_POSTS["facebook"]["id"]
        ig = META_POSTS["instagram"]["id"]
        self.assertEqual(self.matches("facebook", META_PERMALINKS["facebook"],
                                      f"https://facebook.com/watch/?v={fb}"), [True] * 2)
        self.assertEqual(self.matches("instagram", META_PERMALINKS["instagram"],
                                      f"https://instagram.com/anton.yehorov/reels/{ig}/?hl=en",
                                      f"https://www.instagram.com/p/{ig}/"), [True] * 3)

    def test_rejects_other_posts_and_login_redirects(self):
        for name, permalink in META_PERMALINKS.items():
            with self.subTest(name=name):
                self.assertEqual(self.matches(name, permalink.rstrip("/") + "0",
                                              "https://other.example/reel/" + META_POSTS[name]["id"],
                                              "https://www." + name + ".com/accounts/login/?next=" + permalink,
                                              permalink.replace("https:", "http:"),
                                              permalink.rstrip("/") + "/comments"), [False] * 5)

    def test_rejects_wrong_author_and_ambiguous_watch(self):
        fb = META_POSTS["facebook"]["id"]
        ig = META_POSTS["instagram"]["id"]
        self.assertEqual(self.matches("facebook", f"https://www.facebook.com/watch/?v=other&v={fb}"), [False])
        self.assertEqual(self.matches("instagram", f"https://www.instagram.com/other/reel/{ig}/"), [False])

    def test_login_overlay_or_recommendation_cannot_bind_a_player(self):
        # jsdom supplies actual DOM ancestry and selectors. Geometry and hit
        # testing are explicit because this fast test has no compositor.
        extension = Path(__file__).resolve().parents[2] / "apps/extension"
        setup = """
const { JSDOM } = require('jsdom');
const { window } = new JSDOM(`<main>
    <article><a href="/reel/DexOm8xRMCb/">post</a><div><video id="post"></video>
    <button aria-label="Log in"></button></div></article>
    <article><a href="/reel/other/">suggestion</a><video id="suggested"></video></article>
  </main>`, {url: postURL});
Object.assign(globalThis,{document:window.document,location:window.location,innerWidth:1000,innerHeight:720});
const bounds = {top:20,left:20,bottom:420,right:620,width:600,height:400};
window.Element.prototype.getBoundingClientRect = () => bounds;
window.Element.prototype.checkVisibility = () => true;
const video = document.getElementById('post');
document.elementFromPoint = () => video;
if (select(post, false) !== video) throw new Error('missing the primary player');
document.elementFromPoint = () => document.querySelector('button');
if (select(post, false)) throw new Error('accepted an unrelated action');
document.elementFromPoint = () => document.getElementById('suggested');
if (select(post, false)) throw new Error('accepted a recommendation');
"""
        program = (f"const post = {json.dumps(META_POSTS['instagram'])}; "
                   f"const postURL = {json.dumps(META_PERMALINKS['instagram'])}; "
                   f"const select = {TARGET_PLAYER};" + setup)
        subprocess.run(["node", "-e", program], check=True, cwd=extension)

    def test_only_offer_to_close_a_visible_optional_account_prompt(self):
        extension = Path(__file__).resolve().parents[2] / "apps/extension"
        program = f"const optionalClose = {OPTIONAL_CLOSE}; " + """
const { JSDOM } = require('jsdom');
const { window } = new JSDOM(`<div role="dialog"><h2>Log in to Instagram</h2></div>`);
const d = window.document;
globalThis.document = d;
Object.assign(globalThis, {innerWidth: 1000, innerHeight: 720});
const dialog = d.querySelector('[role=dialog]');
window.Element.prototype.checkVisibility = () => true;
window.Element.prototype.getBoundingClientRect = () => ({x:20,y:20,width:80,height:40});
if (optionalClose()) throw new Error('mandatory sign-in must stay blocked');
dialog.insertAdjacentHTML('beforeend', '<button aria-label="Close"></button>');
d.elementFromPoint = () => d.querySelector('button');
if (!optionalClose()) throw new Error('missed the optional public viewer');
dialog.querySelector('h2').textContent = 'Discard draft?';
if (optionalClose()) throw new Error('attempted to dismiss an unrelated dialog');
"""
        subprocess.run(["node", "-e", program], check=True, cwd=extension)

    def test_optional_cookie_refusal_and_native_play_are_bound_to_public_viewer(self):
        extension = Path(__file__).resolve().parents[2] / "apps/extension"
        program = (f"const post={json.dumps(META_POSTS['facebook'])}; "
                   f"const url={json.dumps(META_PERMALINKS['facebook'])}; "
                   f"const close={OPTIONAL_CLOSE}, play={POST_PLAY}, diagnostics={DIAGNOSTICS};") + """
const {window} = new (require('jsdom').JSDOM)(`<div role=dialog><h2>Allow cookies on Facebook?</h2>
<button>Allow all cookies</button><button>Decline optional cookies</button></div><main>
<article><a href="/reel/1473526454600527/">Post</a><button aria-label="Play video"></button></article>
<article><a href="/reel/987/">Other</a><button aria-label="Play video"></button></article></main>`, {url});
const d=window.document;
Object.assign(globalThis,{document:d, location:window.location, innerWidth:1000, innerHeight:720});
window.Element.prototype.checkVisibility=()=>true;
window.Element.prototype.getBoundingClientRect=()=>({x:10,y:10,width:120,height:50});
let target = d.querySelector('button:nth-of-type(2)');
d.elementFromPoint = () => target;
if (!close()) throw new Error('missed a visible refuse-optional option');
target = d.querySelector('button');
if (close()) throw new Error('selected the accept-all button');
d.querySelector('[role=dialog]').remove();
target = d.querySelectorAll('article button')[1];
if (play(post)) throw new Error('selected a different post');
target = d.querySelectorAll('article button')[0];
if (!play(post)) throw new Error('missed the target native play button before decoder creation');
d.body.innerHTML += '<input type="password"><div>secret prompt, https://private.example/</div>';
const state = diagnostics(post);
if (!state.passwordField || !state.expectedRoute || state.videos !== 0 ||
    /private[.]example|secret prompt/.test(JSON.stringify(state))) throw new Error('diagnostic leaked body or missed gate');
"""
        subprocess.run(["node", "-e", program], check=True, cwd=extension)
