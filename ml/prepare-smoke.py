#!/usr/bin/env python3
"""Decode explicitly supplied local smoke fixtures to bounded RGBA. No network.

Images require Pillow. Videos require ffprobe/ffmpeg. Test fixtures and analysis
stay on disk locally; this is an offline developer tool, not extension code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--asset", help="Only prepare the indicated SHA-256; other fixture files are not opened")
    parser.add_argument("--browser-sampling", action="store_true", help="Approximate the installed extension's bounded video acquisition")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    prepared = []
    for line in args.manifest.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if args.asset and row["sha256"] != args.asset:
            continue
        path = (args.manifest.parent / row["file"]).resolve()
        if args.manifest.parent.resolve() not in path.parents:
            raise ValueError("Fixture path escapes manifest directory")
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        if checksum != row["sha256"]:
            raise ValueError(f"Fixture checksum mismatch: {row['file']}")
        if "kind" not in row and path.suffix.lower() in {".mp4", ".webm"}:
            row["kind"] = "video"
        if row["kind"] == "image":
            with Image.open(path) as image:
                if image.width * image.height > 40_000_000:
                    raise ValueError("Image exceeds the extension decode pixel budget")
                image = image.convert("RGBA")
                image.thumbnail((1024, 1024), Image.Resampling.BILINEAR)
                rgba_path = args.output / f"{checksum}.rgba"
                rgba_path.write_bytes(image.tobytes())
                prepared.append({**row, "width": image.width, "height": image.height, "rgba_path": str(rgba_path.resolve())})
        elif row["kind"] == "video":
            metadata = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration:format=duration", "-of", "json", str(path),
            ]))
            stream = metadata["streams"][0]
            duration = float(stream.get("duration") or metadata["format"]["duration"])
            scale = min(1, (480 if args.browser_sampling else 640) / max(stream["width"], stream["height"]))
            width, height = round(stream["width"] * scale), round(stream["height"] * scale)
            frames = []
            if args.browser_sampling:
                if duration <= 0 or duration > 300:
                    raise ValueError("Unsupported video duration")
                interval = min(1, max(.2, duration / 12))
                timestamps = [index * interval for index in range(12) if index * interval < duration]
            else:
                timestamps = [index / 11 * max(0, duration - 0.1) for index in range(12)]
            for index, timestamp in enumerate(timestamps):
                raw = subprocess.check_output([
                    "ffmpeg", "-v", "error", "-ss", f"{timestamp:.6f}", "-i", str(path),
                    "-frames:v", "1", "-vf", f"scale={width}:{height}:flags=bilinear", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1",
                ])
                if len(raw) != width * height * 4:
                    raise ValueError(f"Video frame decode failed: {row['file']} at {timestamp}")
                rgba_path = args.output / f"{checksum}-{index:02}.rgba"
                rgba_path.write_bytes(raw)
                frames.append({"width": width, "height": height, "timestampMs": timestamp * 1000, "rgba_path": str(rgba_path.resolve())})
            prepared.append({**row, "durationMs": duration * 1000, "frames": frames})
        else:
            raise ValueError("Only image and video fixtures are supported")
    if args.asset and len(prepared) != 1:
        raise ValueError("Selected fixture not found or duplicated")
    (args.output / "prepared.json").write_text(json.dumps(prepared, indent=2) + "\n")
    print(str((args.output / "prepared.json").resolve()))


if __name__ == "__main__":
    main()
