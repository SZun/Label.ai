"""Retrieve just the designated public test clips for local processing. No browsing data is used."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import struct
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]/"artifacts/video-smoke"
KLING="https://huggingface.co/datasets/nyuuzyou/klingai/resolve/4ae5e439e4e40b6f70c13bcd2f749d78f8416abe/resource_aa.zip"
MDN="https://raw.githubusercontent.com/mdn/shared-assets/f160bcf2db52b60820a7728aa9b3fa88568cfc38/videos/"
FILES={
    "kling.mp4":"14446dda8bbcfb8458337a7391c34237d4724482e43df3b82df0be4174fb0011",
    "flower.webm":"c6f8a348953395598a9a73b9bab1676436410797bce9f398f4be1531d6e76dda",
    "flower.mp4":"0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451",
}


def download(name):
    if name=="kling.mp4":
        with urlopen(Request(KLING,headers={"Range":"bytes=0-12367500"}),timeout=60) as response:
            prefix=response.read(12_367_501)
        magic,_,flag,method,_,_,_,size,_,n,e=struct.unpack_from("<4s5H3I2H",prefix,0)
        if (magic,flag,method,size)!=(b"PK\x03\x04",0,0,12_366_600):
            raise ValueError("unexpected archive layout")
        data=prefix[30+n+e:30+n+e+size]
    else:
        with urlopen(MDN+name,timeout=30) as response:
            data=response.read(1_500_000)
    if hashlib.sha256(data).hexdigest()!=FILES[name]:
        raise ValueError("fixture digest mismatch: "+name)
    (ROOT/name).write_bytes(data)
    return name


if __name__=="__main__":
    ROOT.mkdir(parents=True,exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        print("Verified video smoke inputs:",", ".join(pool.map(download,FILES)))

    manifest = [
        {"file": name, "sha256": digest, "source": KLING if name == "kling.mp4" else MDN + name,
         "group": "kling-001" if name == "kling.mp4" else "mdn-flower",
         "origin": "generated" if name == "kling.mp4" else "camera",
         "rights": "CC0-1.0 dataset declaration" if name == "kling.mp4" else "MDN public example, local evaluation only",
         "split": "development"}
        for name, digest in FILES.items()
    ]
    (ROOT / "manifest.jsonl").write_text("".join(json.dumps(row) + "\n" for row in manifest))
