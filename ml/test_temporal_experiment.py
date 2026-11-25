import unittest

from ml.calibrate import TEMPORAL_FEATURES
from tools.experiment_temporal_classifier import evaluate


class TemporalFitExperimentTests(unittest.TestCase):
    def test_scored_thirds_veto_a_high_whole_clip_fit(self):
        neutral = {key: 0.0 for key in TEMPORAL_FEATURES}
        fit = {"intercept": 0.0, "coefficients": {**neutral, "meanLogit": 1.0}}
        evidence = {**neutral, "meanLogit": 3.0, "motionEnergy": 0.1,
                    "reasonCodes": ["MIXED_FRAME_EVIDENCE"], "scoreQuantile25": 0.05}
        row = dict(group="source-a", file="example.mp4", sha256="a" * 64, generator="",
                   origin="generated", temporal=evidence, durationMs=12000,
                   logits=[-3] * 12, timestamps=[500 + 1000*i for i in range(12)],
                   thirds=[evidence, evidence, {**evidence, "meanLogit": -1}])
        control = {**row, "origin": "genuine", "group": "source-b"}
        result = evaluate([row, control], fit)
        self.assertTrue(result["rows"][0]["score"] >= .90)
        self.assertFalse(result["rows"][0]["candidate"])
        row["thirds"] = [evidence, evidence, evidence]
        result = evaluate([row, control], fit)
        self.assertTrue(result["rows"][0]["candidate"])
        self.assertFalse(result["rows"][1]["candidate"])
