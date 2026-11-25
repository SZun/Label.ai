"""Create a byte-reproducible ZIP of a previously built extension."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED


def package(build, out):
    build = build.resolve()
    if out.resolve().is_relative_to(build):
        raise ValueError("choose a ZIP destination outside the web extension")
    manifest = json.loads((build/"manifest.json").read_bytes())
    if manifest.get("name") is None or manifest.get("version") is None:
        raise ValueError("invalid extension manifest")
    out.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in build.rglob("*") if p.is_file())
    with ZipFile(out, "w") as archive:
        for file in files:
            if not file.resolve().is_relative_to(build) or file.is_symlink():
                raise ValueError("refusing external assets")
            entry = ZipInfo(file.relative_to(build).as_posix(), (2024,1,1,0,0,0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry,file.read_bytes(),compress_type=ZIP_DEFLATED,compresslevel=6)
    print(f"{out} ({out.stat().st_size:,} bytes, {len(files)} files)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build",type=Path)
    parser.add_argument("output",type=Path)
    args = parser.parse_args()
    package(args.build,args.output)
