"""Run the packaged MV3 extension in a fresh desktop Chromium-family browser profile.

The test server holds a real signed generated photo and an unsigned control. Network
observations cover Playwright-visible targets plus every request reaching the publisher.
A second scan runs after switching this temporary browser context offline.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from tools.demo_page import publisher

TEXT = "AI Slop Detected 🤮"


@contextmanager
def browser_session(pw, profile, launch, args):
    options = {"executable_path":args.browser} if args.browser else {"channel":"chromium"}
    context = pw.chromium.launch_persistent_context(profile,headless=True,args=launch,
        ignore_default_args=["--disable-extensions"],viewport={"width":1000,"height":720},**options)
    try:
        yield context
    finally:
        context.close()


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
        with browser_session(pw,profile,launch,args) as context:
            return exercise_install(context,manifest,build,args,origin,publisher_requests)


def exercise_install(context,manifest,build,args,origin,publisher_requests):
    forbidden=[]
    def requests_seen(request):
        if request.url.startswith(("http://","https://","ws://","wss://")):
            path=request.url.removeprefix(origin)
            expected=request.url.startswith(origin+"/") and (path=="/" or path.startswith("/assets/"))
            if not expected or request.method!="GET" or "?" in request.url:
                forbidden.append([request.method,request.url.split("?")[0]])
    context.on("request",requests_seen)
    # An unpacked extension without a key derives its Chromium ID from the absolute path.
    chars = "abcdefghijklmnop"
    ext = "".join(chars[int(h,16)] for h in hashlib.sha256(os.fsencode(build)).hexdigest()[:32])
    options_page=context.new_page()
    options_page.goto(f"chrome-extension://{ext}/options.html")
    options_page.get_by_role("heading",name="Site access").wait_for()
    options_page.evaluate("chrome.runtime.sendMessage({type:'label-ai:sync'})")
    worker=next((w for w in context.service_workers if w.url.startswith(f"chrome-extension://{ext}/")),None)
    if worker is None:
        worker=context.wait_for_event("serviceworker",predicate=lambda w:w.url.startswith(f"chrome-extension://{ext}/"),timeout=12000)
    version=context.browser.version if context.browser else None
    # Record the packaged extension identity and actual engine for each independent run.
    print(f"Loaded {manifest['name']} {manifest['version']} ({ext}) on {version or args.browser}",flush=True)
    options_path=manifest.get("options_ui",{}).get("page") or manifest.get("options_page") or manifest.get("action",{}).get("default_popup")
    if not options_path:
        raise AssertionError("missing site-access page")
    if args.install_only:
        options_page.get_by_role("heading",name="Site access").wait_for()
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
    return _exercise(site,options_page,worker,context,origin,badge,publisher_requests,version,forbidden)


def _exercise(site,options_page,worker,context,origin,badge,publisher_requests,version,forbidden):
    badge.wait_for(state="visible",timeout=45000)
    assert badge.count()==1
    assert badge.evaluate("(e)=>getComputedStyle(e).pointerEvents")=="none"
    site.evaluate("document.querySelector('#asset').src=document.querySelector('#control').src")
    badge.wait_for(state="detached",timeout=10000)
    site.evaluate("document.querySelector('#asset').src=globalThis.addressed")
    badge.wait_for(state="visible",timeout=45000)
    site.evaluate("document.querySelector('#asset').src=document.querySelector('#control').src")
    badge.wait_for(state="detached",timeout=10000)
    context.set_offline(True)
    site.emulate_media(reduced_motion="reduce")
    site.evaluate("document.querySelector('#asset').src=globalThis.signedSource")
    badge.wait_for(state="visible",timeout=30000)
    assert badge.count()==1
    assert badge.evaluate("(e)=>getComputedStyle(e).animationName")=="none"
    # This runs in the isolated extension content world on the active fixture page.
    # A COMPLETED reply on this unsigned frame requires successful real ONNX inference.
    reply = worker.evaluate("""async () => {
      const [tab] = await chrome.tabs.query({active:true, lastFocusedWindow:true});
      const [response] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
        const control=document.querySelector('#control');
        const canvas=document.createElement('canvas'); canvas.width=160; canvas.height=160;
        const ctx=canvas.getContext('2d'); ctx.drawImage(control,0,0,160,160);
        const pixels=ctx.getImageData(0,0,160,160).data;
        let data=''; for(let i=0;i<pixels.length;i+=4096)data+=String.fromCharCode(...pixels.subarray(i,i+4096));
        return await chrome.runtime.sendMessage({type:'label-ai:analyze',kind:'image',generation:0,
          instanceId:'smoke-control',requestId:crypto.randomUUID(),
          frame:{width:160,height:160,timestampMs:0,rgba:btoa(data)}});
      }});
      return response.result;
    }""")
    assert reply and reply["status"]=="COMPLETED" and reply["shouldLabel"] is False, reply
    site.evaluate("document.querySelector('#asset').remove()")
    badge.wait_for(state="detached",timeout=10000)
    site.evaluate("""() => {
      const feed = document.createElement('section');
      for (let i = 0; i < 240; i++) {
        const row = document.createElement('div');
        const image = document.createElement('img');
        image.src = document.querySelector('#control').src;
        row.append(image); feed.append(row);
      }
      const last = document.createElement('img');
      last.src = globalThis.signedSource;
      feed.append(last); document.body.append(feed);
      last.scrollIntoView();
    }""")
    badge.wait_for(state="visible",timeout=45000)
    assert badge.count()==1, "expected the signed final item of the long feed to be labeled"
    context.set_offline(False)
    options_page.bring_to_front()
    options_page.get_by_role("button",name=f"Remove {origin}").click()
    options_page.wait_for_function("async () => (await chrome.scripting.getRegisteredContentScripts()).length === 0")
    site.bring_to_front()
    site.reload()
    assert badge.count()==0
    assert not forbidden, f"unexpected HTTP/WS traffic: {forbidden}"
    assert all(m=="GET" and "?" not in path for m,path in publisher_requests), publisher_requests
    return {"installed":True,"version":version,"positive":True,"removal":True,
            "offline":True,"offline_model_status":reply["status"],"long_feed_positive":True,"addressed_positive":True,"revocation":True,"reduced_motion":True,"unexpected_requests":forbidden}


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
