#!/usr/bin/env python3
"""Fit image or temporal calibration on a separate local calibration split."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

TEMPORAL_FEATURES = (
    "meanLogit", "lowerQuartileLogit", "logitStd", "logitTemporalDelta",
    "motionEnergy", "secondOrderResidual", "sceneCuts",
)


def usable_features(row: dict, modality: str) -> bool:
    status = row.get("status")
    if status is None:
        # Existing callers may supply already-verified raw feature inventories.
        return True
    if status not in {"COMPLETED", "CANCELED", "FAILED", "UNSUPPORTED"}:
        raise ValueError("Invalid inference status")
    if status != "COMPLETED":
        return False
    if modality == "video":
        return (isinstance(row.get("temporal"), dict) and row["temporal"].get("eligible") is True
                and "LOCAL_TEMPORAL_FEATURES" in row.get("reasonCodes", []))
    return True


def fit_calibration(rows: list[dict], holdout: list[dict], modality: str, manifest_sha256: str) -> dict:
    if modality not in {"image", "video"} or not re.fullmatch("[a-f0-9]{64}", manifest_sha256):
        raise ValueError("Invalid modality or calibration manifest SHA256")
    if not holdout:
        raise ValueError("An independent holdout manifest is required for leakage checking")
    if any(row.get("split") not in {"test", "validation", "release"} for row in holdout):
        raise ValueError("Holdout rows must belong to a test, validation or release split")
    holdout_hashes, holdout_groups = set(), set()
    for row in holdout:
        checksum, group = row.get("sha256", ""), row.get("group", "")
        if not isinstance(checksum, str) or not re.fullmatch("[a-f0-9]{64}", checksum) or checksum in holdout_hashes:
            raise ValueError("Invalid or duplicate holdout digest")
        if not isinstance(group, str) or not group.strip():
            raise ValueError("Holdout rows require a source group")
        holdout_hashes.add(checksum)
        holdout_groups.add(group)
    seen = set()
    features, targets, groups = [], [], []
    for row in rows:
        if row.get("split") != "calibration" or row.get("kind") != modality:
            raise ValueError("Only the matching calibration split may be fitted")
        checksum, group = row.get("sha256", ""), row.get("group", "")
        if not re.fullmatch("[a-f0-9]{64}", checksum) or not isinstance(group, str) or not group:
            raise ValueError("Calibration rows need valid content hashes and grouping identifiers")
        if checksum in holdout_hashes or group in holdout_groups:
            raise ValueError("Calibration/holdout content or group leakage")
        if checksum in seen:
            raise ValueError("Duplicate calibration asset")
        seen.add(checksum)
        if not row.get("license") and not row.get("rights"):
            raise ValueError("Calibration media rights must be documented")
        if row.get("origin") not in {"generated", "genuine", "camera"}:
            raise ValueError("Calibration origin must be independently established")
        if not usable_features(row, modality):
            continue
        try:
            values = [float(row["logit"])] if modality == "image" else [float(row["temporal"][key]) for key in TEMPORAL_FEATURES]
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("Required inference features are missing or invalid") from error
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Nonfinite calibration feature")
        features.append(values)
        targets.append(int(row["origin"] == "generated"))
        groups.append(group)
    for label in (0, 1):
        if len({group for group, target in zip(groups, targets) if target == label}) < 20:
            raise ValueError("At least 20 independent groups per class are required to fit; release validation needs much more")
    x, y = np.asarray(features, dtype=np.float64), np.asarray(targets)
    counts = Counter(groups)
    sample_weight = np.asarray([1 / counts[group] for group in groups])
    scaler = StandardScaler().fit(x, sample_weight=sample_weight)
    classifier = LogisticRegression(C=1.0, max_iter=2000, solver="lbfgs", random_state=0)
    classifier.fit(scaler.transform(x), y, sample_weight=sample_weight)
    # Convert standardized coefficients back to the exact raw runtime feature contract.
    coefficients = classifier.coef_[0] / scaler.scale_
    intercept = float(classifier.intercept_[0] - np.dot(coefficients, scaler.mean_))
    common = {"calibrationSetSha256": manifest_sha256, "intercept": intercept}
    if modality == "image":
        slope = float(coefficients[0])
        if not math.isfinite(slope) or slope <= 0:
            raise ValueError("Fitted image mapping is not monotone; investigate model/data mismatch")
        return {**common, "version": f"image-platt-{manifest_sha256[:12]}", "slope": slope}
    fitted = dict(zip(TEMPORAL_FEATURES, map(float, coefficients)))
    if not any(abs(fitted[key]) > 1e-10 for key in ("motionEnergy", "secondOrderResidual", "logitTemporalDelta")):
        raise ValueError("Fit does not use temporal evidence; cannot advertise a temporal video model")
    return {**common, "version": f"video-logistic-{manifest_sha256[:12]}",
            "featureVersion": "luma32-consecutive-difference2-logit-distribution-v1", "coefficients": fitted}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modality", choices=("image", "video"), required=True)
    parser.add_argument("--input", type=Path, required=True, help="Local JSONL calibration rows joined to actual inference outputs")
    parser.add_argument("--holdout-manifest", type=Path, required=True, help="Separate untouched test/validation inventory; only used to check leakage")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.99,
                        help="Freeze a threshold selected without inspecting holdout outcomes")
    args = parser.parse_args()
    if not math.isfinite(args.threshold) or not .5 <= args.threshold <= 1:
        parser.error("Threshold must be finite and between 0.5 and 1")
    sha = hashlib.sha256(args.input.read_bytes()).hexdigest()
    rows = read_jsonl(args.input)
    model = json.loads((Path(__file__).parent / "model-manifest.json").read_text())
    for row in rows:
        if "status" in row and (
            row.get("modelSha256") != model["sha256"] or
            row.get("wasmSha256") != model["wasm_runtime"]["sha256"] or
            row.get("preprocessingVersion") != model["preprocessing_version"]
        ):
            raise ValueError("Inference features must bind the pinned model/runtime/preprocessing")
    result = {
        "schema_version": 1,
        "modality": args.modality,
        "model_sha256": model["sha256"],
        "preprocessing_version": model["preprocessing_version"],
        "calibration": fit_calibration(rows, read_jsonl(args.holdout_manifest), args.modality, sha),
        "calibration_rows": len(rows),
        "fitted_rows": sum(usable_features(row, args.modality) for row in rows),
        "excluded_inference_rows": sum(not usable_features(row, args.modality) for row in rows),
        "threshold": args.threshold,
        "holdout_manifest_sha256": hashlib.sha256(args.holdout_manifest.read_bytes()).hexdigest(),
        "release_approved": False,
        "notice": "Fitting is not held-out validation. Evaluate frozen parameters on an untouched distribution; review the report before a build-time policy promotion.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(f"Wrote unapproved {args.modality} calibration to {args.output}")


if __name__ == "__main__":
    main()
