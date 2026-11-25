"""Reproduce the separate, paired 224×126 thumbnail experiment."""
import csv
import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor

import PIL
from PIL import Image, ImageOps
from . import evaluate_browsing_sensitivity as base

SIZE = (224, 126)
OUT = base.OUT / "thumbnail"
REPORT = base.ROOT / "ml/reports/frontier-browsing-thumbnails.json"


def prepare():
    metadata = base.frontier.OUT / "metadata.csv"
    if base.download("metadata.csv", metadata, 1_000_000) != base.frontier.METADATA_SHA256:
        raise ValueError("Pinned metadata hash mismatch")
    _, paired = base.select(list(csv.DictReader(metadata.read_text().splitlines())))
    with ThreadPoolExecutor(max_workers=8) as pool:
        sources = list(pool.map(base.fetch, paired))
    reference = {r["group"]: r["sha256"] for r in json.loads(base.REPORT.read_text())["rows"]
                 if r["slice"] == "instagram"}
    if {r["group"]: r["sha256"] for r in sources} != reference:
        raise ValueError("Thumbnail source hashes differ from the paired browsing corpus")
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for source in sources:
        destination = OUT / (source["group"] + ".png")
        with Image.open(base.OUT / source["file"]) as image:
            ImageOps.fit(image.convert("RGB"), SIZE, method=Image.Resampling.LANCZOS,
                         centering=(0.5, 0.5)).save(destination)
        rows.append({**source, "slice": "centered-224x126", "file": destination.name,
                     "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
    manifest = OUT / "corpus.jsonl"
    manifest.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return sources, rows, manifest


def write_report(sources, thumbnails, scores, manifest):
    by_id = {row["group"]: row for row in scores}
    if len(scores) != 38 or len(by_id) != 38:
        raise ValueError("Expected all 38 scored source groups")
    records = []
    for source, image in zip(sources, thumbnails, strict=True):
        row = by_id[source["group"]]
        if row["sha256"] != image["sha256"]:
            raise ValueError("Scored thumbnail digest mismatch")
        records.append(dict(group=row["group"], origin=row["origin"], generator=row["generator"],
                            sourceSha256=source["sha256"], inputSha256=row["sha256"],
                            status=row["status"], rawScore=row.get("rawScore")))
    metrics = {}
    for cutoff in base.CUTOFFS:
        metrics[str(cutoff)] = {}
        for origin, metric in (("generated", "recall"), ("genuine", "false_positive_rate")):
            group = [row for row in records if row["origin"] == origin]
            hits = sum(r["status"] == "COMPLETED" and r["rawScore"] >= cutoff for r in group)
            metrics[str(cutoff)][metric] = base.rate(hits, len(group))
    report = dict(
        sourceReport=base.REPORT.name, datasetRevision=base.frontier.REVISION,
        sourceSlice="All 38 paired Instagram renditions, one per source group, equally divided by origin.",
        method="Pillow ImageOps.fit(image.convert('RGB'), (224, 126), method=Image.Resampling.LANCZOS, "
               "centering=(0.5, 0.5)); save as PNG with default settings. Score locally with the actual WASM image engine.",
        pillowVersion=PIL.__version__, reproduce="python -m tools.evaluate_browsing_thumbnails",
        manifestSha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
        modelSha256=scores[0]["modelSha256"], wasmSha256=scores[0]["wasmSha256"],
        preprocessingVersion=scores[0]["preprocessingVersion"], metrics=metrics,
        interpretation="Paired, centered 16:9 crops of a small development slice. Confidence intervals "
                       "are approximate Wilson 95% intervals. These samples overlap the larger image run.",
        rows=records,
    )
    REPORT.write_text(json.dumps(report, indent=2) + "\n")


def main():
    sources, rows, manifest = prepare()
    if REPORT.exists():
        expected = json.loads(REPORT.read_text())["manifestSha256"]
        if hashlib.sha256(manifest.read_bytes()).hexdigest() != expected:
            raise ValueError("Thumbnail bytes differ from the recorded run; check Pillow version")
    output = OUT / "thumbnail-rerun-pending.jsonl"
    output.unlink(missing_ok=True)
    subprocess.run(["node", "--experimental-strip-types", "packages/detector/tests/run-corpus.ts",
                    "--manifest", str(manifest), "--output", str(output)], cwd=base.ROOT, check=True)
    scores = list(map(json.loads, output.read_text().splitlines()))
    write_report(sources, rows, scores, manifest)
    output.replace(OUT / "thumbnail-scores.jsonl")


if __name__ == "__main__":
    main()
