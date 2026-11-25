"""Prepare a deterministic, attributed development benchmark locally.

Originals and their Instagram copies remain in the same source group.
No download or metric from this script establishes independent release evidence.
"""
import csv
import hashlib
import io
import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen

REVISION = "e6a8b83d15fab1da958848368fcd07e943afafd0"
BASE = ("https://huggingface.co/datasets/wasitaigeneratedcom/"
        f"frontier-image-video-bench-2026-10/resolve/{REVISION}/")
METADATA_SHA256 = "f8063df0a65c41dd66fe259e7c4b86f3bb71f7fe10e9ccc52df091ba9b09873c"
OUT = Path(__file__).resolve().parents[1] / "artifacts/frontier-dev"
SEED = "label-ai-frontier-dev-v1"


def order(row):
    return hashlib.sha256(f"{SEED}:{row['id']}".encode()).hexdigest()


def select(rows):
    images = defaultdict(dict)
    for row in rows:
        if row["media"] == "image":
            images[row["id"]][row["variant"]] = row
    originals = [pair["original"] for pair in images.values()
                 if "original" in pair and "instagram" in pair]
    by_generator = defaultdict(list)
    for row in originals:
        if row["label"] == "ai":
            by_generator[row["generator"]].append(row)
    chosen = [min(group, key=order) for _, group in sorted(by_generator.items())]
    genuine = []
    seen_sources = set()
    for row in sorted(originals, key=order):
        if row["label"] != "real" or row["source_url"] in seen_sources:
            continue
        genuine.append(row)
        seen_sources.add(row["source_url"])
        if len(genuine) == len(chosen):
            break
    assert len(chosen) == len(genuine) == 19
    output = [images[row["id"]][variant] for row in chosen + genuine
              for variant in ("original", "instagram")]
    clips = [row for row in rows if row["media"] == "video" and row["variant"] == "original"]
    # A small, fixed, source-distinct video subset is for development only.
    for label in ("ai", "real"):
        groups = set()
        for row in sorted(clips, key=order):
            group = row["generator"] if label == "ai" else row["source_url"]
            if row["label"] != label or group in groups:
                continue
            output.append(row)
            groups.add(group)
            if len(groups) == 3:
                break
    assert len(output) == 82
    return output


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    metadata = OUT / "metadata.csv"
    if not metadata.exists():
        with urlopen(BASE + "metadata.csv", timeout=30) as response:
            metadata.write_bytes(response.read(1_000_001))
    data = metadata.read_bytes()
    if hashlib.sha256(data).hexdigest() != METADATA_SHA256:
        raise ValueError("Pinned metadata checksum mismatch")
    selected = select(list(csv.DictReader(io.StringIO(data.decode()))))
    report = OUT.parents[1] / "ml/reports/frontier-dev-2026-10.json"
    expected = {}
    if report.exists():
        expected = {row["file"]: row["sha256"] for row in json.loads(report.read_text())["rows"]}

    def fetch(row):
        assert row["license"] and row["author"]
        relative = Path(row["file"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unexpected dataset path")
        destination = OUT / relative
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Published evaluation media, fetched by a developer; never browser data.
            with urlopen(BASE + row["file"], timeout=30) as response:
                data = response.read(40_000_001)
            if len(data) > 40_000_000:
                raise ValueError("Dataset fixture exceeds download limit")
            destination.write_bytes(data)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if expected and digest != expected.get(row["file"]):
            raise ValueError("Development asset differs from recorded benchmark: " + row["file"])
        print(row["file"], flush=True)
        return dict(file=row["file"], sha256=digest,
                    kind=row["media"], origin="generated" if row["label"] == "ai" else "genuine",
                    source=row["source_url"] or BASE + row["file"], license=row["license"],
                    author=row["author"], generator=row["generator"], group=row["id"],
                    split="development", slice=row["variant"])

    with ThreadPoolExecutor(max_workers=12) as pool:
        manifest = list(pool.map(fetch, selected))
    for kind in ("image", "video"):
        (OUT / f"{kind}-manifest.jsonl").write_text(
            "".join(json.dumps(row) + "\n" for row in manifest if row["kind"] == kind)
        )
    (OUT / "originals-manifest.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in manifest
                if row["kind"] == "image" and row["slice"] == "original")
    )
    print(f"Prepared {len(manifest)} attributed development assets in {OUT}")


if __name__ == "__main__":
    main()
