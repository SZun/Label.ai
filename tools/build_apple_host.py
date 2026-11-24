"""Compile app and extension without distribution signatures on a macOS Xcode host."""
import argparse
import json
from pathlib import Path
import subprocess


def build(location):
    projects = list(location.rglob("*.xcodeproj"))
    if len(projects) != 1:
        raise SystemExit(f"Expected one Xcode project, found {len(projects)}")
    cmd = ["xcodebuild","-project",str(projects[0])]
    schemes = json.loads(subprocess.check_output(cmd+["-list","-json"]))["project"]["schemes"]
    for platform, destination in (("macOS","generic/platform=macOS"), ("iOS","generic/platform=iOS Simulator")):
        app = [s for s in schemes if platform.lower() in s.lower() and "extension" not in s.lower()]
        if len(app) != 1:
            raise SystemExit(f"Expected a {platform} application scheme in {schemes}")
        subprocess.run(cmd+["-scheme",app[0],"-configuration","Debug","-destination",destination,
                            "-derivedDataPath",str(location/"build"/platform),
                            "CODE_SIGNING_ALLOWED=NO","build"],check=True)


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_directory",type=Path)
    build(parser.parse_args().project_directory)
