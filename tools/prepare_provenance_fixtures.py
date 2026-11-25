"""Materialize pinned upstream credential examples and a reproducible tampered control."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures/provenance"

def verify(data, row):
    return len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"]

def prepare():
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    rows = {row["file"]: row for row in manifest["assets"]}
    def fetch(row):
        path = FIXTURES / row["file"]
        if path.exists() and verify(path.read_bytes(), row):
            return
        url = f"https://raw.githubusercontent.com/contentauth/example-assets/{manifest['sourceCommit']}/{row['upstreamPath']}"
        with urlopen(url, timeout=45) as response:
            data = response.read(row["bytes"] + 1)
        if not verify(data, row):
            raise ValueError(f"Credential fixture digest mismatch in {path.name}")
        path.write_bytes(data)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch, [row for row in rows.values() if "upstreamPath" in row and "transformation" not in row]))
    altered = bytearray((FIXTURES / "firefly-generated.jpg").read_bytes())
    altered[126648] = 9
    target = rows["firefly-tampered.jpg"]
    if not verify(altered, target):
        raise ValueError("Tampered control digest mismatch")
    (FIXTURES / target["file"]).write_bytes(altered)
    for file, row in rows.items():
        if not verify((FIXTURES / file).read_bytes(), row):
            raise ValueError(f"Invalid fixture: {file}")
    print(f"Verified {len(rows)} credential fixtures.")

if __name__ == "__main__":
    prepare()
