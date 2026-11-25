"""A social site's loading animation or login wall is not proof of visible playback."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from meta_public_video import check_visible_motion, prepare_meta_player


class PublicVideoMotionTest(unittest.TestCase):
    def play(self, images, frames, positions=None):
        page, player = Mock(), Mock()
        bound = player.element_handle.return_value
        sequence = []
        positions = positions or [20] * len(frames)
        for idx, (frame, x) in enumerate(zip(frames, positions)):
            sequence.append({"clips": [{"x": x, "y": 50, "width": 32, "height": 32}],
                             "frames": frame, "time": idx * 0.3})
        bound.evaluate.side_effect = sequence
        page.screenshot.side_effect = images
        return check_visible_motion(page, player)

    def test_requires_motion_over_two_intervals_of_presented_frames(self):
        self.play([b'a', b'b', b'c'], [0, 8, 15])

    def test_rejects_a_single_cover_transition_and_moving_controls_over_stalled_decoder(self):
        with self.assertRaises(AssertionError):
            self.play([b'a'] + [b'b']*6, list(range(7)))
        with self.assertRaises(AssertionError):
            self.play([bytes([i]) for i in range(7)], [1]*7)

    def test_viewport_relayout_is_not_motion(self):
        with self.assertRaises(AssertionError):
            self.play([bytes([i]) for i in range(7)], list(range(7)), [20, 21]*3 + [20])

    def test_diagnostic_failure_preserves_original_failure_and_hides_page_data(self):
        page = Mock()
        page.is_closed.return_value = False
        page.evaluate.side_effect = RuntimeError("private diagnostic")
        with patch("meta_public_video._play_meta_post", side_effect=RuntimeError("source replaced")):
            with redirect_stdout(StringIO()) as captured, self.assertRaisesRegex(RuntimeError, "source replaced"):
                prepare_meta_player(page, "facebook")
            self.assertNotIn("private diagnostic", captured.getvalue())

    def test_tiktok_prompt_only_dismisses_explicit_account_controls(self):
        import subprocess
        from tiktok_viewer import VIEWER_STATE
        extension = Path(__file__).resolve().parents[2] / 'apps/extension'
        setup = """
const {window} = new (require('jsdom').JSDOM)(`<article><video></video></article>
<div role=dialog><h2>Log in to TikTok</h2><button>Not now</button></div>`,
{url:"https://www.tiktok.com/@bigfootvlogs/video/7508418787968830742"});
const d=window.document;
Object.assign(globalThis,{document:d,location:window.location, innerWidth:1000,innerHeight:720,
getComputedStyle:window.getComputedStyle.bind(window)});
const rect={x:0,y:0,top:0,left:0,right:400,bottom:400,width:400,height:400};
window.Element.prototype.getBoundingClientRect=()=>rect;
window.Element.prototype.checkVisibility=()=>true;
let hit = d.querySelector('button'); d.elementFromPoint=()=>hit;
const v=d.querySelector('video'), expected=location.href;
if (state(v,expected).kind!=='dismiss') throw Error('missed optional account prompt');
d.querySelector('button').textContent = 'Sign in';
if (state(v,expected).kind!=='account') throw Error('attempted to use required sign-in');
d.querySelector('h2').textContent = 'Delete post?'; d.querySelector('button').textContent = 'Close';
if (state(v,expected).kind==='dismiss') throw Error('dismissed an unrelated action');
d.querySelector('[role=dialog]').remove();hit=d.body.appendChild(d.createElement('div'));
hit.style.backgroundColor='rgba(0,0,0,0.68)';
if (state(v,expected).kind!=='scrim') throw Error('missed visible overlay');
if (state(v,expected + '0').kind!=='other-post') throw Error('left the expected post');
"""
        subprocess.run(["node","-e", "const state=" + VIEWER_STATE + ";" + setup], cwd=extension, check=True)

    def test_late_prompt_prevents_acceptance_until_result_is_visible_again(self):
        from tiktok_viewer import wait_on_tiktok
        page, wait_for_badge = Mock(), Mock()
        states = ["clear", "clear", "dismiss", "dismiss", "clear", "clear"]
        with patch("tiktok_viewer.inspect_viewer", side_effect=states) as viewer, \
             patch("tiktok_viewer.check_visible_motion", side_effect=[AssertionError("hidden"), None]) as motion:
            wait_on_tiktok(page, "video", "https://test.example/reel", wait_for_badge, TimeoutError)
        self.assertEqual(viewer.call_count, 6)
        self.assertEqual(motion.call_count, 2)
        self.assertEqual(wait_for_badge.call_count, 3)
