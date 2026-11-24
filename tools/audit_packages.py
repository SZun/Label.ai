"""Check the generated WebExtension manifests and shipped resources, before zipping."""
import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

PROHIBITED = {"cookies","history","debugger","tabCapture","desktopCapture","nativeMessaging",
              "webRequestBlocking","webRequest","downloads","clipboardRead","clipboardWrite"}


class ActiveResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script","iframe","object","embed"} or (tag=="link" and attrs.get("rel") in {"stylesheet","modulepreload"}):
            self.urls.extend(attrs[k] for k in ("href","src","data") if k in attrs and attrs[k])


def inspect_build(build):
    m = json.loads((build/"manifest.json").read_text())
    errors = []
    if m.get("host_permissions"):
        errors.append("host permissions must be optional at install time")
    if m.get("content_scripts"):
        errors.append("static content scripts would run before a site grant")
    if m.get("manifest_version") != 3:
        errors.append("expected manifest version 3")
    for perm in sorted(PROHIBITED & set(m.get("permissions",[])+m.get("optional_permissions",[]))):
        errors.append("unexpected permission: "+perm)
    policy = m.get("content_security_policy",{}).get("extension_pages","")
    directives = {p.split()[0]:p.split()[1:] for p in policy.split(";") if p.strip()}
    if directives.get("connect-src") not in (["'self'"],["'none'"]):
        errors.append("connect-src must prevent connections to remote hosts")
    if set(directives.get("script-src",[])) - {"'self'","'wasm-unsafe-eval'"} or "'self'" not in directives.get("script-src",[]):
        errors.append("script-src must limit execution to the extension package")
    bg = m.get("background",{})
    paths = [bg[k] for k in ("service_worker","page") if k in bg] + bg.get("scripts",[])
    for block in m.get("content_scripts",[]):
        paths += block.get("js",[])+block.get("css",[])
    paths += list(m.get("icons",{}).values())
    for item in paths:
        if not (build/item.lstrip("/")).is_file():
            errors.append("missing manifest resource: "+item)
    for p in build.rglob("*.html"):
        parser = ActiveResources()
        parser.feed(p.read_text())
        for url in parser.urls:
            if urlsplit(url).scheme or url.startswith("//"):
                errors.append(f"{p.name} loads a nonpackaged resource: {url}")
    for p in build.rglob("*"):
        if p.suffix in {".key",".p12",".map"} or p.name in {".env","test-root.pem","test-root.crt"}:
            errors.append(f"unexpected release file: {p.name}")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("builds",nargs="+",type=Path)
    problems = []
    for directory in parser.parse_args().builds:
        problems.extend(f"{directory}: {e}" for e in inspect_build(directory))
    if problems:
        raise SystemExit("\n".join(problems))
    print("Package policy checks passed.")
