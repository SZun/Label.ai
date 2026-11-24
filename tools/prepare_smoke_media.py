"""Download a small, fixed DEVELOPMENT set for offline image inference; never for release."""
import binascii
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import struct
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "smoke-media"
ARCHIVE = ("https://huggingface.co/datasets/poloclub/diffusiondb/resolve/"
           "fb620fbe49fa4420e0734bd9c0df11f51176b61f/images/part-000001.zip")
PHOTOS = {"camera.png":"Lav Varshney", "coffee.png":"Rachel Michetti",
          "chelsea.png":"Stefan van der Walt","astronaut.png":"NASA"}
BASE = "https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/"
KNOWN = ROOT / "tests" / "fixtures" / "smoke-digests.json"


def get_photo(name):
    with urllib.request.urlopen(BASE+name, timeout=30) as f:
        return name, f.read(5_000_000)


def generated():
    # Read only a bounded range at a pinned revision. ZIP members are never extracted to disk paths.
    req = urllib.request.Request(ARCHIVE, headers={"Range":"bytes=0-2999999"})
    with urllib.request.urlopen(req,timeout=30) as f:
        prefix = f.read(3_000_000)
    pos = 0
    for _ in range(4):
        magic, _, flag, method, _, _, crc, size, unpacked, n, e = struct.unpack_from("<4s5H3I2H",prefix,pos)
        if magic != b"PK\x03\x04" or flag or method!=8 or unpacked>4_000_000:
            raise ValueError("unexpected ZIP member layout")
        name = prefix[pos+30:pos+30+n].decode("ascii")
        start = pos+30+n+e
        data = zlib.decompressobj(-15).decompress(prefix[start:start+size],4_000_001)
        if len(data)!=unpacked or binascii.crc32(data)!=crc:
            raise ValueError("ZIP integrity check failed")
        yield name, data
        pos = start + size


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    def save(name, data, origin, credit, license_name):
        if Path(name).name != name or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("invalid image")
        digest = hashlib.sha256(data).hexdigest()
        rows.append(dict(file=name,sha256=digest,kind="image",origin=origin,source=credit,
                         license=license_name,group=name,split="test",slice="original"))
        (OUT/name).write_bytes(data)
    for name, data in generated():
        save(name,data,"generated","DiffusionDB / Stable Diffusion","CC0-1.0")
    with ThreadPoolExecutor(max_workers=4) as pool:
        for name,data in pool.map(get_photo,PHOTOS):
            save(name,data,"genuine",PHOTOS[name],"Public domain" if name=="astronaut.png" else "CC0-1.0")
    digests = {r["file"]:r["sha256"] for r in rows}
    if digests != json.loads(KNOWN.read_text()):
        raise ValueError("source digest mismatch; do not use this development set")
    (OUT/"manifest.jsonl").write_text("".join(json.dumps(r)+"\n" for r in rows))
    print(f"Verified {len(rows)} development samples in {OUT}")


if __name__=="__main__":
    main()
