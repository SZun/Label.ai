"""Reproduce the frozen browsing-cutoff comparison on fresh Frontier source groups.

Run from the provisioned repository root: python -m tools.evaluate_browsing_sensitivity
Only public benchmark files are downloaded, into ignored artifacts/.
"""
import csv
import hashlib
import io
import json
import math
import subprocess
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from . import prepare_frontier_dev as frontier

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/frontier-browsing-sensitivity"
REPORT = ROOT / "ml/reports/frontier-browsing-sensitivity.json"
SEED = "label-ai-browsing-sensitivity-v1"
CUTOFFS = (0.65, 0.10)
SELECTION_SHA256 = "f8380a0d59da72c54029dddf38f38b1811bd492e23e4d710e74456972821da60"


def rank(row):
    return hashlib.sha256(f"{SEED}:{row['id']}".encode()).digest()


def select(rows):
    prior = [r for r in frontier.select(rows) if r["media"] == "image"]
    prior_ids = {r["id"] for r in prior}
    sources = {r["source_url"] for r in prior if r["source_url"]}
    authors = {r["author"].casefold().strip() for r in prior if r["label"] == "real"}
    groups = defaultdict(dict)
    for row in rows:
        if row["media"] == "image" and row["id"] not in prior_ids:
            groups[row["id"]][row["variant"]] = row
    ordered = sorted((pair["original"] for pair in groups.values()
                      if "original" in pair and "instagram" in pair), key=rank)
    by_generator = defaultdict(list)
    genuine = []
    for row in ordered:
        if row["label"] == "ai":
            by_generator[row["generator"]].append(row)
        elif row["label"] == "real":
            author = row["author"].casefold().strip()
            if author and row["source_url"] and row["source_url"] not in sources and author not in authors:
                sources.add(row["source_url"])
                authors.add(author)
                genuine.append(row)
    if len(by_generator) != 19 or any(len(members) < 3 for members in by_generator.values()):
        raise ValueError("Expected at least three eligible originals from each of nineteen generators")
    generated = [row for _, members in sorted(by_generator.items()) for row in members[:3]]
    originals = generated + genuine[:len(generated)]
    if len(originals) != 114 or len({r["id"] for r in originals}) != 114:
        raise ValueError("Expected 114 distinct source groups")
    # One paired Instagram recompression per generator, plus 19 genuine pairs.
    paired = [members[0] for _, members in sorted(by_generator.items())] + genuine[:19]
    return originals, [groups[r["id"]]["instagram"] for r in paired]


def download(relative, destination, limit):
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                with urlopen(frontier.BASE + relative, timeout=40) as response:
                    data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError(f"Oversized dataset file: {relative}")
                temporary = destination.with_suffix(".tmp")
                temporary.write_bytes(data)
                temporary.replace(destination)
                break
            except (TimeoutError, URLError, ConnectionError):
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def fetch(row):
    path = Path(row["file"])
    if path.is_absolute() or ".." in path.parts or not row["license"] or not row["author"]:
        raise ValueError(f"Invalid dataset entry: {row['id']}")
    return dict(file=row["file"], sha256=download(row["file"], OUT / path, 40_000_000),
                kind="image", origin="generated" if row["label"] == "ai" else "genuine",
                source=row["source_url"] or frontier.BASE + row["file"], license=row["license"],
                author=row["author"], generator=row["generator"], group=row["id"],
                split="development", slice=row["variant"])


def rate(hits, n):
    z = 1.959963984540054
    p = hits / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    width = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return {"hits": hits, "n": n, "rate": round(p, 4),
            "wilson95": [round(max(0, center - width), 4), round(min(1, center + width), 4)]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    metadata = frontier.OUT / "metadata.csv"
    if download("metadata.csv", metadata, 1_000_000) != frontier.METADATA_SHA256:
        raise ValueError("Pinned metadata hash mismatch")
    originals, pairs = select(list(csv.DictReader(io.StringIO(metadata.read_text()))))
    all_assets = originals + pairs
    selection = "\n".join(r["file"] for r in all_assets) + "\n"
    selection_sha = hashlib.sha256(selection.encode()).hexdigest()
    if selection_sha != SELECTION_SHA256:
        raise ValueError("Source selection differs from the predeclared evaluation")
    print(f"Selection SHA256 {selection_sha}", flush=True)
    prior_digests = None
    if REPORT.exists():
        prior_digests = {r["file"]: r["sha256"] for r in json.loads(REPORT.read_text())["rows"]}
    raw = []
    manifests = {}
    for name, rows in (("original", originals), ("instagram", pairs)):
        with ThreadPoolExecutor(max_workers=12) as pool:
            manifest_rows = list(pool.map(fetch, rows))
        if prior_digests is not None:
            for row in manifest_rows:
                if prior_digests.get(row["file"]) != row["sha256"]:
                    raise ValueError(f"Asset differs from the measured corpus: {row['file']}")
        manifest = OUT / f"{name}.jsonl"
        manifest.write_text("".join(json.dumps(r) + "\n" for r in manifest_rows))
        manifests[name] = hashlib.sha256(manifest.read_bytes()).hexdigest()
        scores = OUT / f"{name}-scores.jsonl"
        temporary = OUT / f"{name}-pending.jsonl"
        temporary.unlink(missing_ok=True)
        subprocess.run(["node", "--experimental-strip-types", "packages/detector/tests/run-corpus.ts",
                        "--manifest", str(manifest), "--output", str(temporary)], cwd=ROOT, check=True)
        temporary.replace(scores)
        raw.extend(json.loads(line) for line in scores.read_text().splitlines())
    write_report(raw, manifests, selection_sha)


def write_report(raw, manifests, selection_sha):
    if len({r["sha256"] for r in raw}) != len(raw):
        raise ValueError("Duplicated asset digest")
    prior = json.loads((ROOT / "ml/reports/frontier-dev-2026-10.json").read_text())["rows"]
    if {r["group"] for r in raw} & {r["group"] for r in prior}:
        raise ValueError("Source group overlaps the earlier development evaluation")
    if {r["sha256"] for r in raw} & {r["sha256"] for r in prior}:
        raise ValueError("File overlaps the earlier development evaluation")
    summary = {}
    for name in ("original", "instagram"):
        summary[name] = {}
        for cutoff in CUTOFFS:
            metrics = {}
            for label, metric in (("generated", "recall"), ("genuine", "false_positive_rate")):
                group = [r for r in raw if r["slice"] == name and r["origin"] == label]
                metrics[metric] = rate(sum(r["status"] == "COMPLETED" and
                                            isinstance(r.get("rawScore"), (float, int)) and
                                            r["rawScore"] >= cutoff for r in group), len(group))
            summary[name][str(cutoff)] = metrics
    unavailable = [{"file": r["file"], "status": r["status"], "reasonCodes": r["reasonCodes"]}
                   for r in raw if r["status"] != "COMPLETED"]
    report = {"dataset": "wasitaigeneratedcom/frontier-image-video-bench-2026-10",
              "datasetRevision": frontier.REVISION, "metadataSha256": frontier.METADATA_SHA256,
              "seed": SEED, "selectionSha256": selection_sha,
              "manifestSha256": manifests, "modelSha256": raw[0]["modelSha256"],
              "wasmSha256": raw[0]["wasmSha256"], "preprocessingVersion": raw[0]["preprocessingVersion"],
              "protocol": (
                  "Preselected raw-score cutoffs, 3 original images per generator, 57 genuine photographs "
                  "from distinct authors and source URLs. All 114 source IDs are disjoint from the earlier "
                  "Frontier development set. The Instagram slice reuses 38 of those IDs and is measured "
                  "separately. Offline WASM using the repository's Pillow fixture decoder. Failed decodes "
                  "count as abstentions in the denominator. Wilson 95% intervals are approximate per slice. "
                  "Site-wide precision, model-training independence and release criteria remain unverified."
              ),
              "failures": len(unavailable), "unscoredAssets": unavailable, "metrics": summary,
              "rows": [{k: r.get(k) for k in ("file", "sha256", "group", "origin", "generator", "slice", "status", "rawScore")} for r in raw]}
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
