"""Math/contracts only. Synthetic rows are never accuracy/release evidence."""
import hashlib
import math
import unittest

from calibrate import fit_calibration


def rows(kind="image"):
    output = []
    for index in range(40):
        generated = index >= 20
        value = (index % 20) / 20
        output.append({
            "sha256": hashlib.sha256(f"synthetic-math-test-{index}".encode()).hexdigest(),
            "group": f"unit-test-{index}", "split": "calibration", "kind": kind,
            "origin": "generated" if generated else "genuine", "license": "synthetic unit test",
            "logit": (3 if generated else -3) + value,
            "temporal": {"meanLogit": (3 if generated else -3) + value,
                         "lowerQuartileLogit": (2 if generated else -4) + value,
                         "logitStd": 0.4 + value, "logitTemporalDelta": 0.2 + value,
                         "motionEnergy": 0.01 + (0.2 if generated else 0) + value / 100,
                         "secondOrderResidual": 0.002 + (0.03 if generated else 0) + value / 1000,
                         "sceneCuts": 0},
        })
    return output


def holdout():
    return [{"sha256": "e" * 64, "group": "separate-test-group", "split": "test"}]


class CalibrationTests(unittest.TestCase):
    def test_image_fit_returns_monotone_finite_platt_parameters(self):
        result = fit_calibration(rows(), holdout(), "image", "f" * 64)
        self.assertGreater(result["slope"], 0)
        self.assertTrue(math.isfinite(result["intercept"]))
        self.assertEqual(result["calibrationSetSha256"], "f" * 64)

    def test_video_fit_uses_real_temporal_feature_contract(self):
        result = fit_calibration(rows("video"), holdout(), "video", "f" * 64)
        self.assertGreater(abs(result["coefficients"]["secondOrderResidual"]), 0)
        self.assertIn("consecutive", result["featureVersion"])

    def test_blocks_training_on_holdout_and_group_or_content_leakage(self):
        for bad in ["split", "group", "sha256"]:
            data = rows()
            data[0][bad] = {"split": "test", "group": "separate-test-group", "sha256": "e" * 64}[bad]
            with self.assertRaisesRegex(ValueError, "split|leakage"):
                fit_calibration(data, holdout(), "image", "f" * 64)

    def test_blocks_duplicate_assets_nonfinite_features_and_missing_classes(self):
        duplicate = rows()
        duplicate[1]["sha256"] = duplicate[0]["sha256"]
        invalid = rows()
        invalid[0]["logit"] = math.nan
        for data in [duplicate, invalid, rows()[:20]]:
            with self.assertRaises(ValueError):
                fit_calibration(data, holdout(), "image", "f" * 64)


if __name__ == "__main__":
    unittest.main()
