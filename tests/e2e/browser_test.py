"""Run the packaged MV3 extension in a fresh desktop Chromium-family browser profile.

The test server holds a real signed generated photo and an unsigned control. Network
observations cover Playwright-visible targets plus every request reaching the publisher.
A second scan runs after switching this temporary browser context offline.
"""
import argparse
import base64
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import zlib
import struct
import shutil

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SIGNED = ROOT / "tests/fixtures/provenance/firefly-generated.jpg"
TEXT = "AI Slop Detected 🤮"


def ramp_png():
    def chunk(tag,data):
        return struct.pack(">I",len(data))+tag+data+struct.pack(">I",zlib.crc32(tag+data))
    w,h=240,170
    pixels=b"".join(b'\0'+bytes(((x+y)%250 for x in range(w))) for y in range(h))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack(">IIBBBBB",w,h,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')


@contextmanager
def publisher():
    blobs = {"signed":SIGNED.read_bytes(), "unsigned":ramp_png()}
    resources = {"/assets/"+hashlib.sha256(v).hexdigest()+(".jpg" if k=="signed" else ".png"):v for k,v in blobs.items()}
    paths = list(resources)
    requests=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):
            pass
        def do_GET(self):
            requests.append(("GET",self.path))
            if self.path in resources:
                data=resources[self.path]
                mime="image/jpeg" if self.path.endswith(".jpg") else "image/png"
            elif self.path=="/":
                uris={k:"data:image/"+("jpeg" if k=="signed" else "png")+";base64,"+base64.b64encode(v).decode() for k,v in blobs.items()}
                data=(f'<!doctype html><meta charset=utf-8><title>Label.ai local acceptance</title>'
                      f'<link rel=icon href="data:,"><style>img{{width:240px;height:170px;object-fit:contain}}</style>'
                      f'<img id=asset alt="Fixture artwork" src="{uris["signed"]}">'
                      f'<img id=control alt="Conventional gradient" src="{uris["unsigned"]}">'
                      f'<script>globalThis.signedSource={json.dumps(uris["signed"])};globalThis.addressed={json.dumps(paths[0])};</script>').encode()
                mime="text/html"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type",mime)
            self.send_header("Content-Length",str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_POST(self):
            requests.append(("POST",self.path))
            self.send_error(405)
        do_PUT=do_POST
    server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}",requests
    finally:
        server.shutdown()
        server.server_close()


def run(args):
    build=args.build.resolve()
    manifest=json.loads((build/"manifest.json").read_text())
    with publisher() as (origin,publisher_requests), TemporaryDirectory() as profile, sync_playwright() as pw:
        if args.pregrant_test_origin:
            # Headless Chromium cannot interact with the native site-grant bubble.
            # Only this test copy adds the loopback publisher to required host grants.
            copied = Path(profile)/"test-build"
            shutil.copytree(build,copied)
            test_manifest = dict(manifest)
            pattern = "http://127.0.0.1/*"
            test_manifest["host_permissions"] = list(dict.fromkeys(manifest.get("host_permissions",[])+[pattern]))
            test_manifest["optional_host_permissions"] = [p for p in manifest.get("optional_host_permissions",[]) if p!=pattern]
            (copied/"manifest.json").write_text(json.dumps(test_manifest))
            build=copied
        launch=["--disable-extensions-except="+str(build),"--load-extension="+str(build),
                "--disable-background-networking","--disable-component-update","--disable-sync",
                "--no-first-run","--no-default-browser-check","--disable-dev-shm-usage"]
        options={"executable_path":args.browser} if args.browser else {"channel":"chromium"}
        context=pw.chromium.launch_persistent_context(profile,headless=True,
                args=launch,ignore_default_args=["--disable-extensions"],viewport={"width":1000,"height":720},**options)
        forbidden=[]
        def requests_seen(request):
            if request.url.startswith(("http://","https://","ws://","wss://")):
                path=request.url.removeprefix(origin)
                expected=request.url.startswith(origin+"/") and (path=="/" or path.startswith("/assets/"))
                if not expected or request.method!="GET" or "?" in request.url:
                    forbidden.append([request.method,request.url.split("?")[0]])
        context.on("request",requests_seen)
        try:
            worker=context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker",timeout=12000)
            ext=worker.url.split("/")[2]
            version=context.browser.version if context.browser else None
            # Record the packaged extension identity and actual engine for each independent run.
            print(f"Loaded {manifest['name']} {manifest['version']} ({ext}) on {version or args.browser}",flush=True)
            options_path=manifest.get("options_ui",{}).get("page") or manifest.get("options_page") or manifest.get("action",{}).get("default_popup")
            if not options_path:
                raise AssertionError("missing site-access page")
            options_page=context.new_page()
            options_page.goto(f"chrome-extension://{ext}/{options_path}")
            if args.install_only:
                assert options_page.locator("body").inner_text().strip()
                return {"installed":True,"version":version,"options":options_path}
            site=context.new_page()
            site.goto(origin)
            badge=site.get_by_text(TEXT,exact=True)
            assert badge.count()==0, "unexpected badge before user grants access"

            # Set permission through the options page's real user-gesture handler.
            options_page.bring_to_front()
            options_page.get_by_role("textbox").first.fill(origin)
            options_page.get_by_role("button",name=args.enable_button).click()
            options_page.get_by_text("Local analysis enabled.",exact=False).wait_for(timeout=12000)
            options_page.wait_for_function("""async () => (await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === 'label-ai-media')""",timeout=12000)
            site.bring_to_front()
            site.reload()
            return _exercise(site,context,origin,badge,publisher_requests,version,forbidden)
        finally:
            context.close()


def _exercise(site,context,origin,badge,publisher_requests,version,forbidden):
    badge.wait_for(state="visible",timeout=45000)
    assert badge.count()==1
    assert badge.evaluate("(e)=>getComputedStyle(e).pointerEvents")=="none"
    site.evaluate("document.querySelector('#asset').src=document.querySelector('#control').src")
    badge.wait_for(state="detached",timeout=10000)
    context.set_offline(True)
    site.emulate_media(reduced_motion="reduce")
    site.evaluate("document.querySelector('#asset').src=globalThis.signedSource")
    badge.wait_for(state="visible",timeout=30000)
    assert badge.count()==1
    assert badge.evaluate("(e)=>getComputedStyle(e).animationName")=="none"
    site.evaluate("document.querySelector('#asset').remove()")
    badge.wait_for(state="detached",timeout=10000)
    assert not forbidden, f"unexpected HTTP/WS traffic: {forbidden}"
    assert all(m=="GET" and "?" not in path for m,path in publisher_requests), publisher_requests
    return {"installed":True,"version":version,"positive":True,"removal":True,
            "offline":True,"reduced_motion":True,"unexpected_requests":forbidden}


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build",type=Path,required=True)
    parser.add_argument("--browser",default=os.getenv("LABEL_TEST_BROWSER"))
    parser.add_argument("--pregrant-test-origin",action="store_true",help="Add loopback host grant to a disposable copy for headless E2E")
    parser.add_argument("--install-only",action="store_true")
    parser.add_argument("--enable-button",default="Enable on this site")
    parser.add_argument("--report",type=Path)
    args=parser.parse_args()
    result=run(args)
    print(json.dumps(result))
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(result,indent=2)+"\n")
