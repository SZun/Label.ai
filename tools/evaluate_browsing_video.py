"""Run the frozen short-video model comparison: python -m tools.evaluate_browsing_video."""
import csv
import hashlib
import json
import math
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

from . import evaluate_browsing_sensitivity as base
from . import prepare_frontier_dev as frontier
from . import prepare_video_smoke as smoke

OUT = base.ROOT / "artifacts/frontier-video-browsing"
REPORT = base.ROOT / "ml/reports/frontier-browsing-video.json"
SEED = "label-ai-video-browsing-v1"
SELECTION_SHA = "19a2e507823bd22eded8da781ec0b91ca691f345ce969ee91467f05f702a16de"


def select(rows):
    dev = [r for r in frontier.select(rows) if r["media"] == "video"]
    used = {r["id"] for r in dev}
    urls = {r["source_url"] for r in dev}
    authors = {r["author"].strip().casefold() for r in dev if r["label"] == "real"}
    remaining = sorted((r for r in rows if r["media"] == "video" and r["variant"] == "original"
                        and r["id"] not in used),
                       key=lambda r: hashlib.sha256(f"{SEED}:{r['id']}".encode()).digest())
    generators = {}
    genuine = []
    for row in remaining:
        if row["label"] == "ai":
            generators.setdefault(row["generator"], row)
        elif row["source_url"] not in urls and row["author"].strip().casefold() not in authors:
            urls.add(row["source_url"])
            authors.add(row["author"].strip().casefold())
            genuine.append(row)
    test = [generators[key] for key in sorted(generators)] + genuine[:len(generators)]
    selection = "\n".join(r["file"] for r in test) + "\n"
    if hashlib.sha256(selection.encode()).hexdigest() != SELECTION_SHA:
        raise ValueError("Fresh video selection differs from the predeclared source groups")
    return dev, test


def fetch(row):
    dest = OUT / row["file"]
    checksum = base.download(row["file"], dest, 60_000_000)
    return dict(file=row["file"], sha256=checksum, kind="video", group=row["id"],
                origin="generated" if row["label"] == "ai" else "genuine",
                source=row["source_url"] or frontier.BASE + row["file"], license=row["license"],
                author=row["author"], generator=row["generator"], slice="original", split="development")


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    metadata = frontier.OUT / "metadata.csv"
    if base.download("metadata.csv", metadata, 1_000_000) != frontier.METADATA_SHA256:
        raise ValueError("Pinned metadata hash mismatch")
    dev, test = select(list(csv.DictReader(metadata.read_text().splitlines())))
    if not (smoke.ROOT / "manifest.jsonl").is_file():
        subprocess.run([sys.executable, "-m", "tools.prepare_video_smoke"], cwd=base.ROOT, check=True)
    manifests = {}
    for name, selected in (("dev", dev), ("evaluation", test)):
        with ThreadPoolExecutor(8) as pool:
            rows = list(pool.map(fetch, selected))
        if name == "dev":
            for line in (smoke.ROOT / "manifest.jsonl").read_text().splitlines():
                item = json.loads(line)
                data = (smoke.ROOT / item["file"]).read_bytes()
                if hashlib.sha256(data).hexdigest() != smoke.FILES[item["file"]]:
                    raise ValueError("Smoke video integrity failure")
                (OUT / item["file"]).write_bytes(data)
                rows.append(dict(file=item["file"], sha256=item["sha256"], kind="video",
                                 group=item["group"], origin="genuine" if item["origin"] == "camera" else "generated",
                                 source=item["source"], license=item["rights"],
                                 author="nyuuzyou" if item["origin"] == "generated" else "MDN",
                                 generator="Kling" if item["origin"] == "generated" else "",
                                 slice="original", split="development"))
        path = OUT / f"{name}.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        manifests[name] = rows
    if REPORT.exists():
        expected = {r["file"]: r["sha256"] for r in json.loads(REPORT.read_text())["rows"]}
        if expected != {r["file"]: r["sha256"] for rows in manifests.values() for r in rows}:
            raise ValueError("Measured source bytes differ from the checked-in report")
    return manifests


def decisions(row):
    if "error" in row:
        return False, False, []
    evidence = row["temporal"]
    reasons = set(evidence["reasonCodes"])
    old = not reasons and evidence["scoreQuantile25"] >= 0.65
    thirds = [[], [], []]
    for logit, timestamp in zip(row["logits"], row["timestamps"], strict=True):
        index = min(2, int(3 * timestamp / row["durationMs"]))
        thirds[index].append(logit >= math.log(0.10 / 0.90))
    counts = [(sum(group), len(group)) for group in thirds]
    sustained = (not reasons.difference({"MIXED_FRAME_EVIDENCE"}) and
                 evidence["motionEnergy"] >= 0.01 and evidence["scoreQuantile25"] >= 0.10 and
                 all(hits >= 2 and 2 * hits > n for hits, n in counts))
    return old, old or sustained, counts


def summarize(rows):
    # The two MDN encodings are one control source. An incorrect label on either is an error.
    metrics = {}
    for origin, metric in (("generated", "recall"), ("genuine", "false_positive_rate")):
        groups = defaultdict(list)
        for row in rows:
            if row["origin"] == origin:
                groups[row["group"]].append(row)
        metrics[metric] = {policy: base.rate(sum(any(r[policy] for r in items)
                                                for items in groups.values()), len(groups))
                           for policy in ("baseline", "candidate")}
    return metrics


def write_report(manifests, scored):
    model = json.loads((base.ROOT / "ml/model-manifest.json").read_text())
    records = []
    summaries = {}
    for name, expected in manifests.items():
        by_file = {r["file"]: r for r in scored[name]}
        group = []
        for source in expected:
            row = by_file[source["file"]]
            if row["sha256"] != source["sha256"]:
                raise ValueError("Video digest changed during scoring")
            old, new, counts = decisions(row)
            record = {k: row[k] for k in ("file", "sha256", "group", "origin", "generator", "license", "source")}
            record.update(cohort=name, baseline=old, candidate=new, passingAndTotalByThird=counts)
            if "error" in row:
                record["error"] = row["error"]
            else:
                record.update(durationMs=row["durationMs"], timestampsMs=row["timestamps"],
                              logits=row["logits"], temporal={k: row["temporal"][k] for k in (
                                  "coverage", "denseTriplets", "sceneCuts", "motionEnergy",
                                  "secondOrderResidual", "scoreQuantile25", "eligible", "reasonCodes",
                                  "meanLogit", "lowerQuartileLogit", "logitStd", "logitTemporalDelta",
                                  "frameCount", "sampleSpanMs")})
            group.append(record)
        summaries[name] = summarize(group)
        records.extend(group)
    report = dict(datasetRevision=frontier.REVISION, selectionSha256=SELECTION_SHA, seed=SEED,
                  modelSha256=model["sha256"], wasmSha256=model["wasm_runtime"]["sha256"],
                  reproduce="python -m tools.evaluate_browsing_video",
                  sampling="12 ideal playback targets, four per timeline third, longest side at most 480. "
                           "FFmpeg fixture decode, packaged WASM model and production temporal feature extraction.",
                  policy="Baseline: original eligibility and lower-quartile score >= 0.65. Candidate retains "
                         "the baseline and adds a sustained-evidence route. Only the mixed-frame reason may "
                         "be present, motion energy >= 0.01, lower-quartile score >= 0.10, and at least two "
                         "passing frames and a strict majority scoring >= 0.10 in every timeline third.",
                  scope="Fresh evaluation uses one source per generator and unique genuine authors and URLs, "
                        "disjoint from the development videos. These short, public clips do not validate "
                        "long videos, live streams or deployed false-positive rates. Wilson 95% intervals "
                        "are approximate. Both MDN encodings count as one genuine source.",
                  metrics=summaries, rows=records)
    REPORT.write_text(json.dumps(report, indent=2) + "\n")


def main():
    manifests = prepare()
    scored = {}
    for name in manifests:
        path = OUT / f"{name}-rerun-pending.jsonl"
        path.unlink(missing_ok=True)
        subprocess.run(["node", "--experimental-strip-types", "packages/detector/tests/score-video-corpus.ts",
                        str(OUT / f"{name}.jsonl"), str(path)], cwd=base.ROOT, check=True)
        scored[name] = list(map(json.loads, path.read_text().splitlines()))
        path.replace(OUT / f"{name}-scores.jsonl")
    write_report(manifests, scored)


if __name__ == "__main__":
    main()
