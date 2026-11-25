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

    def test_release_split_can_be_frozen_before_calibration(self):
        frozen = [{**holdout()[0], "split": "release"}]
        self.assertGreater(fit_calibration(rows(), frozen, "image", "f" * 64)["slope"], 0)
        for bad in (
            [{**frozen[0], "sha256": "not-a-digest"}],
            [{**frozen[0], "group": ""}],
            frozen * 2,
        ):
            with self.assertRaises(ValueError):
                fit_calibration(rows(), bad, "image", "f" * 64)

    def test_blocks_training_on_holdout_and_group_or_content_leakage(self):
        for bad in ["split", "group", "sha256"]:
            data = rows()
            data[0][bad] = {"split": "test", "group": "separate-test-group", "sha256": "e" * 64}[bad]
            with self.assertRaisesRegex(ValueError, "split|leakage"):
                fit_calibration(data, holdout(), "image", "f" * 64)

    def test_failed_and_ineligible_inferences_cannot_enter_fit(self):
        candidates = rows("video")
        for row in candidates:
            row["status"] = "COMPLETED"
            row["temporal"]["eligible"] = True
            row["reasonCodes"] = ["LOCAL_TEMPORAL_FEATURES"]
        unusable = {**candidates[0], "sha256": "0" * 64, "group": "unsupported",
                    "status": "FAILED", "temporal": None}
        fit = fit_calibration(candidates + [unusable], holdout(), "video", "f" * 64)
        self.assertEqual(fit["intercept"], fit_calibration(candidates, holdout(), "video", "f" * 64)["intercept"])
        candidates[0]["temporal"]["eligible"] = False
        with self.assertRaisesRegex(ValueError, "independent groups"):
            fit_calibration(candidates, holdout(), "video", "f" * 64)

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
