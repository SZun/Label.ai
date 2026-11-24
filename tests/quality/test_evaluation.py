import hashlib
import unittest

from tools.evaluation import evaluate, lower_bound, upper_bound


def asset(i, truth, split="release", kind="image"):
    return dict(sha256=hashlib.sha256(str(i).encode()).hexdigest(), origin=truth, group=str(i),
                split=split, kind=kind, license="CC0", source="fixture-author", slice="original")


def prediction(asset, label):
    return dict(sha256=asset["sha256"], decision=label, policy="1", route="test")


class EvaluationTests(unittest.TestCase):
    def test_abstained_positive_is_missed(self):
        assets = [asset(1, "generated"), asset(2, "generated"), asset(3, "genuine")]
        rows = [prediction(a, b) for a,b in zip(assets, ["label","abstain","clear"])]
        r = evaluate(assets, rows)["by_modality"]["image"]
        self.assertEqual((r["tp"], r["fn"], r["tn"], r["abstentions"]), (1,1,1,1))
        self.assertEqual(r["recall"], .5)
        self.assertFalse(r["passes"])

    def test_missing_and_duplicate_predictions_rejected(self):
        a = asset(1,"generated")
        for rows in ([], [prediction(a,"clear")] * 2):
            with self.assertRaises(ValueError):
                evaluate([a], rows)

    def test_group_leakage_rejected(self):
        a, b = asset(1,"generated"), asset(2,"generated","calibration")
        b["group"] = a["group"]
        with self.assertRaisesRegex(ValueError,"group"):
            evaluate([a,b], [prediction(a,"clear")])

    def test_dependent_release_units_rejected(self):
        a,b = asset(1,"genuine"),asset(2,"genuine")
        b["group"] = a["group"]
        with self.assertRaisesRegex(ValueError,"independent"):
            evaluate([a,b], [prediction(a,"label"), prediction(b,"label")])

    def test_zero_predictions_never_pass(self):
        a = asset(1,"genuine")
        r = evaluate([a], [prediction(a,"clear")])
        self.assertIsNone(r["by_modality"]["image"]["precision"])
        self.assertFalse(r["passes"])

    def test_exact_one_sided_boundary(self):
        self.assertGreater(upper_bound(0,2994),.001)
        self.assertLess(upper_bound(0,3000),.001)
        self.assertAlmostEqual(lower_bound(299,299), 0.05 ** (1/299))
        self.assertAlmostEqual(upper_bound(2,10),.5069013, places=6)


if __name__ == "__main__":
    unittest.main()
