"""Run the required public players and retain each site's outcome."""

from datetime import datetime, timezone
import hashlib
import json
from urllib.parse import urlsplit

REQUIRED_PLATFORMS = ("youtube", "tiktok", "facebook", "instagram", "x")


def open_public_post(page, platform, url, sign_in_first=False, confirm=input):
    if sign_in_first:
        origin = urlsplit(url)
        page.goto(f"{origin.scheme}://{origin.netloc}/", wait_until="domcontentloaded", timeout=60_000)
        confirm(f"Sign in to {platform} in the test window. Press Enter here once signed in: ")
    return page.goto(url, wait_until="domcontentloaded", timeout=60_000)


def check_platforms(check):
    results = {}
    for platform in REQUIRED_PLATFORMS:
        try:
            check(platform)
        except (AssertionError, RuntimeError) as error:
            print(f"{platform}: FAIL ({error})", flush=True)
            results[platform] = False
        else:
            results[platform] = True
    print("Live video badge results", flush=True)
    for platform, passed in results.items():
        print(f"  {platform}: {'PASS' if passed else 'FAIL'}", flush=True)
    return results


def write_report(path, build, results, sign_in_first):
    # Identify the unpacked extension by the contents Chrome was given. A source
    # checkout alone cannot establish which build the operator selected.
    digest = hashlib.sha256()
    for file in sorted(build.rglob("*")):
        if file.is_file() and file.relative_to(build).parts[0] != "_metadata":
            digest.update(file.relative_to(build).as_posix().encode() + b"\0")
            with file.open("rb") as stream:
                content = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    content.update(block)
                digest.update(content.digest())
    report = {
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "extension_version": json.loads((build / "manifest.json").read_text())["version"],
        "build_sha256": digest.hexdigest(),
        "session": "manual-sign-in-requested" if sign_in_first else "guest",
        "platforms": {site: "pass" if results[site] else "fail" for site in REQUIRED_PLATFORMS},
        "all_five_passed": all(results[site] for site in REQUIRED_PLATFORMS),
    }
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
