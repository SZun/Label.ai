import unittest

from tools.evaluate_browsing_video import decisions


def clip(logits, *, reasons=("MIXED_FRAME_EVIDENCE",), motion=0.04, quartile=0.2):
    return dict(temporal=dict(reasonCodes=reasons, motionEnergy=motion, scoreQuantile25=quartile),
                logits=logits, timestamps=[500 + 1000*i for i in range(12)], durationMs=12000)


class VideoPolicyComparisonTests(unittest.TestCase):
    def test_strict_majority_in_each_third(self):
        # At cutoff 0.1, a frame with logit -1 passes and one with logit -3 fails.
        self.assertEqual(decisions(clip([-1, -1, -1, -3] * 3))[:2], (False, True))
        self.assertEqual(decisions(clip([-1] * 8 + [-1, -1, -3, -3]))[:2], (False, False))

    def test_motion_and_structural_guards_remain_mandatory(self):
        self.assertFalse(decisions(clip([-1] * 12, motion=0.009))[1])
        for reason in ("NO_TEMPORAL_CHANGE", "INSUFFICIENT_TEMPORAL_COVERAGE",
                       "INSUFFICIENT_TEMPORAL_SAMPLES", "EXCESSIVE_SCENE_DISCONTINUITY"):
            self.assertFalse(decisions(clip([-1] * 12, reasons=[reason]))[1])

    def test_existing_high_score_route_and_failures(self):
        self.assertEqual(decisions(clip([2] * 12, reasons=[], motion=0.005, quartile=0.8))[:2],
                         (True, True))
        self.assertEqual(decisions({"error": "unsupported duration"})[:2], (False, False))
