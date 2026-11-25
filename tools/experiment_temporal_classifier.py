"""Source-disjoint, duration-matched optional video calibration experiment, offline."""
import csv
import hashlib
import json
import math
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from ml.calibrate import TEMPORAL_FEATURES, fit_calibration, usable_features

from . import evaluate_browsing_video as first

OUT = first.OUT
REPORT = first.base.ROOT / "ml/reports/frontier-temporal-fit.json"
SEED = "label-ai-temporal-fit-v1"
# Frozen before seeing model outputs. The candidate must also pass every structural gate.
FIT_THRESHOLD = .90


def select():
    metadata = first.frontier.OUT / "metadata.csv"
    if first.base.download("metadata.csv", metadata, 1_000_000) != first.frontier.METADATA_SHA256:
        raise ValueError("Pinned video metadata differs from the measured snapshot")
    rows = list(csv.DictReader(metadata.read_text().splitlines()))
    dev, prior = first.select(rows)
    used = {r["id"] for r in dev + prior}
    used_authors = {r["author"].casefold().strip() for r in dev + prior if r["label"] == "real"}
    used_urls = {r["source_url"] for r in dev + prior if r["label"] == "real"}

    def rank(row):
        return hashlib.sha256(f"{SEED}:{row['id']}".encode()).digest()

    buckets, genuine = defaultdict(list), []
    for row in sorted(rows, key=rank):
        if row["media"] != "video" or row["variant"] != "original" or row["id"] in used:
            continue
        if row["label"] == "ai":
            buckets[row["generator"]].append(row)
        elif row["source_url"] not in used_urls and row["author"].casefold().strip() not in used_authors:
            genuine.append(row)
            used_authors.add(row["author"].casefold().strip())
            used_urls.add(row["source_url"])
    # Round-robin families to avoid filling any cohort with a single generator.
    generated = [members[index] for index in range(max(map(len, buckets.values())))
                 for _, members in sorted(buckets.items()) if index < len(members)]
    partitions = {"temporal-fit": generated[22:58] + genuine[22:58],
                  "temporal-validation": generated[:22] + genuine[:22]}
    pinned = {"temporal-fit": "0df9db072e9974dd3685af2fabcd26e08e04b07e56b476168c0926bbfb2e562a",
              "temporal-validation": "6d65e4f67fefb8acbe633b4947584af4d8f03993c0391ae44b1d745c4cff8c8e"}
    if any(name_hash(records) != pinned[name] for name, records in partitions.items()):
        raise ValueError("Video feature experiment selection differs from the frozen cohort")
    return partitions


def name_hash(rows):
    selection = "\n".join(r["file"] for r in rows) + "\n"
    return hashlib.sha256(selection.encode()).hexdigest()


def score(name, rows, matched=True):
    # Small independent Node/WASM workers avoid holding multiple input clips in memory.
    with ThreadPoolExecutor(10) as pool:
        assets = list(pool.map(first.fetch, rows))
    if REPORT.exists():
        previous = json.loads(REPORT.read_text())
        inventory = previous["training"] + previous["matchedWindow"]["rows"]
        by_group = {r["group"]: r["sha256"] for r in inventory}
        if any(by_group.get(row["group"]) != row["sha256"] for row in assets):
            raise ValueError("Selected video bytes differ from the recorded run")

    def shard(i):
        path = OUT / f"{name}-{i}.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in assets[i::5]))
        result = OUT / f"{name}-scores-{i}.jsonl"
        if result.exists():
            result.unlink()
        subprocess.run(["node", "--experimental-strip-types", "packages/detector/tests/score-video-corpus.ts",
                        str(path), str(result), *(["--center-four-seconds"] if matched else [])],
                       cwd=first.base.ROOT, check=True)

    with ThreadPoolExecutor(5) as pool:
        list(pool.map(shard, range(5)))


def load_scored(name, selected):
    scored = [json.loads(line) for i in range(5)
              for line in (OUT / f"{name}-scores-{i}.jsonl").read_text().splitlines()]
    by_id = {row["group"]: row for row in scored}
    if len(by_id) != len(selected):
        raise ValueError("Incomplete or duplicate scored input")
    return [by_id[item["id"]] for item in selected]


def prepare_fitting_rows(rows):
    result = []
    for row in rows:
        available = "error" not in row
        result.append({**row, "status": "COMPLETED" if available else "FAILED",
                       "reasonCodes": ["LOCAL_TEMPORAL_FEATURES"] if available else [],
                       "split": "calibration"})
    return result


def logistic(temporal, fit):
    z = fit["intercept"] + sum(fit["coefficients"][k] * temporal[k] for k in TEMPORAL_FEATURES)
    return 1 / (1 + math.exp(-max(-700, min(700, z))))


def evaluate(rows, fit):
    records = []
    for row in rows:
        baseline, sustained, _ = first.decisions(row)
        fitted = False
        whole = None
        thirds = []
        if "error" not in row:
            evidence = row["temporal"]
            whole = logistic(evidence, fit)
            thirds = [logistic(t, fit) if t else None for t in row["thirds"]]
            fitted = (not set(evidence["reasonCodes"]).difference({"MIXED_FRAME_EVIDENCE"})
                      and evidence["motionEnergy"] >= .01 and whole >= FIT_THRESHOLD
                      and all(p is not None and p >= .5 for p in thirds))
        records.append(dict(group=row["group"], origin=row["origin"], sha256=row["sha256"],
                            file=row["file"], generator=row["generator"], baseline=baseline,
                            sustained=sustained, fittedOnly=fitted, candidate=sustained or fitted,
                            score=whole, scoresByThird=thirds, error=row.get("error")))
    metrics = {}
    for origin in ("generated", "genuine"):
        groups = [r for r in records if r["origin"] == origin]
        metrics[origin] = {k: first.base.rate(sum(r[k] for r in groups), len(groups))
                           for k in ("baseline", "sustained", "fittedOnly", "candidate")}
    # Threshold-independent diagnostic on successfully scored inputs; failures
    # remain in every recall and false-positive-rate denominator above.
    generated = [r["score"] for r in records if r["origin"] == "generated" and r["score"] is not None]
    genuine = [r["score"] for r in records if r["origin"] == "genuine" and r["score"] is not None]
    pairs = len(generated) * len(genuine)
    wins = sum((a > b) + .5 * (a == b) for a in generated for b in genuine)
    return {"metrics": metrics, "wholeScoreAUROC": wins / pairs if pairs else None, "rows": records}


def fit_training(train, holdout):
    # The production calibration contract discards structural and mixed-frame failures.
    fit_input = ("\n".join(json.dumps({k: row.get(k) for k in
                 ("group", "sha256", "origin", "temporal", "status")}, sort_keys=True)
                 for row in train) + "\n").encode()
    inventory = [{"sha256": row["sha256"], "group": row["group"], "split": "validation"}
                 for row in holdout]
    return fit_calibration(train, inventory, "video", hashlib.sha256(fit_input).hexdigest())


def report(partitions, native=None):
    scored = {k: load_scored(k, v) for k, v in partitions.items()}
    train = prepare_fitting_rows(scored["temporal-fit"])
    test = scored["temporal-validation"]
    fitted = fit_training(train, test)
    source_model = json.loads((first.base.ROOT / "ml/model-manifest.json").read_text())
    output = dict(
        status="Research experiment. The fitted classifier is evaluated offline and is not part of the extension.",
        datasetRevision=first.frontier.REVISION, seed=SEED,
        selectionSha256={k: name_hash(v) for k, v in partitions.items()},
        modelSha256=source_model["sha256"], wasmSha256=source_model["wasm_runtime"]["sha256"],
        reproduce="python -m tools.experiment_temporal_classifier",
        method="Existing seven-feature standardized logistic calibration, C=1. Training excludes "
               "unusable/mixed rows via the production calibration contract. All feature windows are "
               "four seconds at the center of each source; failed/short test clips remain as abstentions. "
               "The additional route requires whole probability >= 0.90 and probability >= 0.50 in "
               "each third, motion >= 0.01, and no structural rejection. Identical source IDs, camera "
               "URLs and camera authors were excluded across development, training and validation.",
        limitations="Corpus-specific. Generated sources come from one publisher and genuine footage from "
                    "Wikimedia. Balanced class counts and short clips do not establish browsing precision.",
        training=[dict(group=r["group"], sha256=r["sha256"], origin=r["origin"],
                       used=usable_features(r, "video")) for r in train],
        calibration=fitted, matchedWindow=evaluate(test, fitted))
    metrics = output["matchedWindow"]["metrics"]
    warrants_followup = (metrics["generated"]["candidate"]["hits"] > metrics["generated"]["sustained"]["hits"]
                         and metrics["genuine"]["candidate"]["hits"] == metrics["genuine"]["sustained"]["hits"])
    output["nativeDurationFollowup"] = {
        "criterion": "Adds generated detections without adding genuine false positives on matched windows.",
        "warranted": warrants_followup,
    }
    if native is not None:
        output["nativeDuration"] = evaluate(native, fitted)
    REPORT.write_text(json.dumps(output, indent=2) + "\n")
    return output


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    partitions = select()
    for name, rows in partitions.items():
        print(name, len(rows), name_hash(rows), flush=True)
        score(name, rows)
    output = report(partitions)
    print(json.dumps(output["matchedWindow"]["metrics"], indent=2))
    if output["nativeDurationFollowup"]["warranted"]:
        score("temporal-native", partitions["temporal-validation"], matched=False)
        report(partitions, load_scored("temporal-native", partitions["temporal-validation"]))


if __name__ == "__main__":
    main()
