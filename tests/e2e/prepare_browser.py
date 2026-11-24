"""Extract a digest-pinned desktop browser to an isolated CI temp folder, without running its installer."""
import argparse
from hashlib import file_digest
import json
from pathlib import Path
import shutil
import subprocess
from urllib.request import urlopen

def provision(name, dest):
    source = json.loads(Path(__file__).with_name("browser-sources.json").read_text())[name]
    dest.mkdir(parents=True,exist_ok=True)
    package = dest / (name + ".deb")
    with urlopen(source["url"],timeout=90) as response, package.open("wb") as out:
        shutil.copyfileobj(response,out,1024*1024)
    with package.open("rb") as archive:
        if file_digest(archive,"sha256").hexdigest() != source["sha256"]:
            raise ValueError("Browser package checksum mismatch")
    subprocess.run(["dpkg-deb","-x",str(package),str(dest)],check=True)
    exe = dest / source["executable"]
    if not exe.is_file():
        raise FileNotFoundError(exe)
    print(exe.resolve())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("browser",choices=["brave","edge","opera","vivaldi"])
    parser.add_argument("destination",type=Path)
    args = parser.parse_args()
    provision(args.browser,args.destination)
