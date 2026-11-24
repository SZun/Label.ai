"""Native Vivaldi acceptance through explicitly selected CDP targets.

Run under a real desktop or xvfb-run. No Playwright browser initialization or
Target.setAutoAttach is used: Vivaldi's proprietary UI is never attached.
Protocol: https://chromedevtools.github.io/devtools-protocol/

The production build is never modified. --pregrant-test-origin changes only a
disposable copy, because native optional-permission bubbles are outside CDP's DOM.
That test exercises the real consent UI and its revocation/registration behavior;
it does not claim to automate the browser's optional-host permission bubble.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from urllib.parse import urlsplit

from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.demo_page import publisher

TEXT = "AI Slop Detected 🤮"
CURRENT_STEP = "initialization"
BADGES = r"""(() => {
  const found = [];
  function visit(root) {
    for (const label of root.querySelectorAll('.slop-label')) {
      const rect = label.getBoundingClientRect(), style = getComputedStyle(label);
      if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
        found.push({text:label.textContent.replace(/\s+/g,' ').trim(), pointerEvents:style.pointerEvents,
          animationName:style.animationName, title:label.getAttribute('title')});
      }
    }
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
  }
  visit(document); return found;
})()"""


class CdpError(RuntimeError):
    pass


class CDP:
    """Multiplex documented flattened sessions on the browser WebSocket."""

    def __init__(self, socket, origin):
        self.socket = socket
        self.origin = origin
        self.publisher_paths = {"/"}
        self.next_id = 0
        self.pending = {}
        self.labels = {}
        self.requests = []
        self.unexpected = []
        self.errors = []
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                future = self.pending.get(message.get("id"))
                if future is not None and not future.done():
                    future.set_result(message)
                elif "method" in message:
                    self._event(message)
        except Exception as error:
            for future in tuple(self.pending.values()):
                if not future.done():
                    future.set_exception(CdpError(f"CDP connection closed: {error}"))

    def _event(self, message):
        label = self.labels.get(message.get("sessionId"))
        if not label:
            return
        params = message.get("params", {})
        method = message["method"]
        if method == "Network.requestWillBeSent":
            request = params["request"]
            self.record_request(label, request["method"], request["url"])
        elif method == "Network.webSocketCreated":
            self.record_request(label, "WEBSOCKET", params["url"])
        elif method == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails", {})
            description = detail.get("exception", {}).get("description", detail.get("text", ""))
            self.errors.append({"target": label, "error": str(description)[:1800]})

    def record_request(self, label, method, url):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https", "ws", "wss"):
            return
        # Do not put request bodies or query contents in artifacts.
        record = {"target": label, "method": method,
                  "url": f"{parsed.scheme}://{parsed.netloc.rsplit('@', 1)[-1]}{parsed.path}",
                  "has_query": bool(parsed.query)}
        self.requests.append(record)
        expected = (url.startswith(self.origin + "/") and method == "GET"
                    and not parsed.query and not parsed.fragment
                    and parsed.path in self.publisher_paths)
        if not expected:
            self.unexpected.append(record)

    async def command(self, method, params=None, session=None, timeout=15):
        self.next_id += 1
        command_id = self.next_id
        payload = {"id": command_id, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        future = asyncio.get_running_loop().create_future()
        self.pending[command_id] = future
        try:
            await self.socket.send(json.dumps(payload))
            response = await asyncio.wait_for(future, timeout)
            if "error" in response:
                raise CdpError(f"{method}: {response['error']}")
            return response.get("result", {})
        except TimeoutError as error:
            raise CdpError(f"{method} timed out after {timeout}s on {self.labels.get(session, 'browser')}") from error
        finally:
            self.pending.pop(command_id, None)

    async def attach(self, target_id, label):
        result = await self.command("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session = result["sessionId"]
        self.labels[session] = label
        await self.command("Runtime.enable", session=session)
        await self.command("Network.enable", session=session)
        return session

    async def evaluate(self, session, expression, timeout=15):
        result = await self.command("Runtime.evaluate", {
            "expression": expression, "awaitPromise": True, "returnByValue": True,
            "userGesture": True,
        }, session=session, timeout=timeout)
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise CdpError(str(detail.get("exception", {}).get("description", detail.get("text")))[:2000])
        value = result.get("result", {})
        if value.get("subtype") == "error":
            raise CdpError(str(value.get("description"))[:2000])
        return value.get("value")

    async def wait(self, session, expression, description, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = await self.evaluate(session, expression, timeout=min(8, max(1, deadline-time.monotonic())))
                if result:
                    return result
            except CdpError as error:
                if not any(part in str(error).lower() for part in ("context was destroyed", "cannot find context", "execution context")):
                    raise
            await asyncio.sleep(0.15)
        raise AssertionError(f"Timed out waiting for {description} after {timeout}s")

    async def page(self, label, url):
        target = (await self.command("Target.createTarget", {"url": "about:blank"}))["targetId"]
        session = await self.attach(target, label)
        await self.command("Page.enable", session=session)
        await self.command("Page.navigate", {"url": url}, session=session)
        return target, session

    async def activate(self, target, session):
        await self.command("Target.activateTarget", {"targetId": target})
        await self.command("Page.bringToFront", session=session)
        await self.wait(session, "document.hasFocus() && !document.hidden", "focused document")

    async def click(self, session, text=None, aria=None):
        predicate = ("button.getAttribute('aria-label') === " + json.dumps(aria)) if aria else ("button.textContent.trim() === " + json.dumps(text))
        position = await self.evaluate(session, """(() => {
          const button = [...document.querySelectorAll('button')].find(button => %s);
          if (!button) throw Error('Expected button not found');
          button.scrollIntoView({block:'center'});
          const r = button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()""" % predicate)
        for event in ("mousePressed", "mouseReleased"):
            await self.command("Input.dispatchMouseEvent", {"type": event, "button": "left", "clickCount": 1, **position}, session=session)

    async def offline(self, sessions, offline):
        for session in sessions:
            await self.command("Network.emulateNetworkConditions", {"offline": offline, "latency": 0,
                "downloadThroughput": -1, "uploadThroughput": -1}, session=session)
            await self.command("Network.setBlockedURLs", {"urls": ["http://*", "https://*", "ws://*", "wss://*"] if offline else []}, session=session)

    async def close(self):
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader


def step(name):
    global CURRENT_STEP
    CURRENT_STEP = name
    print(f"[vivaldi] {name}", flush=True)


async def debugger_url(profile, process, log, timeout=35):
    deadline = time.monotonic() + timeout
    marker = profile / "DevToolsActivePort"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Vivaldi exited with {process.returncode}: {log.read_text(errors='replace')[-6000:]}")
        if marker.is_file():
            lines = marker.read_text().splitlines()
            if len(lines) >= 2 and lines[0].isdigit() and lines[1].startswith("/devtools/browser/"):
                port = int(lines[0])
                if 0 < port < 65536:
                    return f"ws://127.0.0.1:{port}{lines[1]}"
        await asyncio.sleep(0.1)
    raise TimeoutError(f"No loopback DevTools endpoint after {timeout}s: {log.read_text(errors='replace')[-6000:]}")


async def extension_worker(cdp, extension_url):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        targets = (await cdp.command("Target.getTargets"))["targetInfos"]
        for target in targets:
            if target["type"] == "service_worker" and target["url"].startswith(extension_url):
                return await cdp.attach(target["targetId"], "extension-worker")
        await asyncio.sleep(0.15)
    raise AssertionError("The packaged extension service worker was not available")


async def exercise(cdp, build, args, origin, publisher_requests):
    chars = "abcdefghijklmnop"
    extension_id = "".join(chars[int(h, 16)] for h in hashlib.sha256(os.fsencode(build)).hexdigest()[:32])
    extension_url = f"chrome-extension://{extension_id}/"
    version = await cdp.command("Browser.getVersion")
    step("Open the packaged extension options")
    options_target, options = await cdp.page("options", extension_url + "options.html")
    await cdp.wait(options, "[...document.querySelectorAll('h2')].some(e=>e.textContent.trim()==='Site access')", "site-access options")
    assert await cdp.evaluate(options, "chrome.runtime.id") == extension_id
    await cdp.evaluate(options, "chrome.runtime.sendMessage({type:'label-ai:sync'})")
    worker = await extension_worker(cdp, extension_url)
    report = {"installed": True, "native_browser": "Vivaldi", "transport": "direct-cdp-explicit-targets",
              "version": version, "extension_id": extension_id, "test_origin_pregranted": args.pregrant_test_origin}
    if args.install_only:
        assert not cdp.unexpected and not cdp.errors, {"network": cdp.unexpected, "runtime": cdp.errors}
        report.update({"unexpected_requests": cdp.unexpected, "observed_requests": cdp.requests,
                       "runtime_errors": cdp.errors})
        step("Unmodified extension install and options checks passed")
        return report

    step("Verify no analysis before consent, then use the real enable control")
    site_target, site = await cdp.page("publisher-page", origin)
    await cdp.activate(site_target, site)
    await cdp.wait(site, "document.querySelector('#asset')?.complete && document.querySelector('#control')?.complete", "fixture images")
    addressed = await cdp.evaluate(site, "globalThis.addressed")
    if not isinstance(addressed, str) or not addressed.startswith("/assets/") or "?" in addressed:
        raise AssertionError("Publisher did not provide the expected addressed original")
    cdp.publisher_paths.add(addressed)
    assert await cdp.evaluate(site, BADGES) == []
    await cdp.activate(options_target, options)
    await cdp.evaluate(options, """(() => {
      const input = document.querySelector('#site');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,%s);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()""" % json.dumps(origin))
    await cdp.click(options, text="Enable on this site")
    await cdp.wait(options, "document.body.textContent.includes('Local analysis enabled.')", "consent saved")
    await cdp.wait(options, "chrome.scripting.getRegisteredContentScripts().then(s=>s.some(x=>x.id==='label-ai-media'))", "consented content registration")
    await cdp.activate(site_target, site)
    await cdp.command("Page.reload", session=site)
    await cdp.wait(site, "document.hasFocus() && !document.hidden", "focused reloaded fixture")

    async def badge(expected, timeout=45):
        return await cdp.wait(site, f"(() => {{const badges={BADGES};return badges.length==={expected} && "
            + (f"badges[0].text==={json.dumps(TEXT)} && badges" if expected else "true") + ";})()",
            f"{expected} rendered .slop-label elements", timeout)

    step("Verify the genuine signed positive and current-source removal")
    labels = await badge(1)
    assert labels[0]["pointerEvents"] == "none" and labels[0]["title"] is None
    await cdp.evaluate(site, "document.querySelector('#asset').src=document.querySelector('#control').src")
    await badge(0, 10)
    # Allow an obsolete asynchronous result a chance to arrive; it must stay hidden.
    await asyncio.sleep(1)
    assert await cdp.evaluate(site, BADGES) == []
    step("Verify hash-addressed original and displayed-pixel binding")
    await cdp.evaluate(site, "document.querySelector('#asset').src=globalThis.addressed")
    await badge(1)
    await cdp.evaluate(site, "document.querySelector('#asset').src=document.querySelector('#control').src")
    await badge(0, 10)

    step("Verify reduced-motion signed provenance entirely offline")
    await cdp.command("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]}, session=site)
    await cdp.offline([site, options, worker], True)
    offline_requests = len(publisher_requests)
    await cdp.evaluate(site, "document.querySelector('#asset').src=globalThis.signedSource")
    labels = await badge(1, 30)
    assert labels[0]["animationName"] == "none"
    step("Run real packaged ONNX inference while every selected target is offline")
    reply = await cdp.evaluate(worker, r"""(async () => {
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if (!tab || !tab.url.startsWith(%s)) throw Error('Fixture is not the active browser tab');
      const [response] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
        const control=document.querySelector('#control');
        const canvas=document.createElement('canvas'); canvas.width=160; canvas.height=160;
        const ctx=canvas.getContext('2d'); ctx.drawImage(control,0,0,160,160);
        const pixels=ctx.getImageData(0,0,160,160).data;
        let data=''; for(let i=0;i<pixels.length;i+=4096)data+=String.fromCharCode(...pixels.subarray(i,i+4096));
        return await chrome.runtime.sendMessage({type:'label-ai:analyze',kind:'image',generation:0,
          instanceId:'vivaldi-offline-control',requestId:crypto.randomUUID(),
          frame:{width:160,height:160,timestampMs:0,rgba:btoa(data)}});
      }}); return response.result;
    })()""" % json.dumps(origin + "/"), timeout=60)
    assert reply and reply["status"] == "COMPLETED" and reply["shouldLabel"] is False, reply
    assert len(publisher_requests) == offline_requests, "Publisher traffic occurred during the offline phase"
    step("Verify DOM removal and consent revocation")
    await cdp.evaluate(site, "document.querySelector('#asset').remove()")
    await badge(0, 10)
    await cdp.offline([site, options, worker], False)
    await cdp.activate(options_target, options)
    await cdp.click(options, aria=f"Remove {origin}")
    await cdp.wait(options, "chrome.scripting.getRegisteredContentScripts().then(s=>s.length===0)", "revoked script registration")
    approved = await cdp.evaluate(options, "chrome.storage.local.get('localSettings').then(s=>s.localSettings.approvedOrigins)")
    assert origin not in approved
    await cdp.activate(site_target, site)
    await cdp.command("Page.reload", session=site)
    await cdp.wait(site, "document.querySelector('#asset')?.complete", "reloaded revoked fixture")
    await asyncio.sleep(1)
    assert await cdp.evaluate(site, "!document.querySelector('label-ai-overlay')")
    assert await cdp.evaluate(site, BADGES) == []
    assert not cdp.unexpected, f"Unexpected page/extension traffic: {cdp.unexpected}"
    assert all(method == "GET" and path in cdp.publisher_paths for method, path in publisher_requests), publisher_requests
    assert not cdp.errors, f"Uncaught runtime errors in tested targets: {cdp.errors}"
    report.update({"positive": True, "stale_source": True, "addressed_positive": True, "offline": True,
        "offline_model_status": reply["status"], "reduced_motion": True, "removal": True, "revocation": True,
        "optional_permission_bubble": "not automated; loopback required grant in disposable test copy",
        "unexpected_requests": cdp.unexpected, "observed_requests": cdp.requests,
        "publisher_requests": publisher_requests, "runtime_errors": cdp.errors,
        "network_scope": "explicit options, publisher-page and extension-worker targets after attachment; all publisher requests"})
    step("All native Vivaldi acceptance checks passed")
    return report


async def run(args):
    source = args.build.resolve()
    manifest = json.loads((source / "manifest.json").read_text())
    assert not manifest.get("host_permissions") and not manifest.get("content_scripts"), "Production build must use optional grants only"
    with publisher() as (origin, publisher_requests), TemporaryDirectory(prefix="labelai-vivaldi-") as temporary:
        temporary = Path(temporary)
        profile = temporary / "profile"
        profile.mkdir()
        build = source
        if args.pregrant_test_origin:
            build = temporary / "test-build"
            shutil.copytree(source, build)
            copied = dict(manifest)
            copied["host_permissions"] = ["http://127.0.0.1/*"]
            copied["optional_host_permissions"] = [p for p in copied.get("optional_host_permissions", []) if p != "http://127.0.0.1/*"]
            (build / "manifest.json").write_text(json.dumps(copied))
        log = temporary / "browser.log"
        launch = [str(Path(args.browser).resolve()), "--user-data-dir=" + str(profile),
            "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
            "--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
            "--disable-background-networking", "--disable-component-update", "--disable-sync",
            "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
            "--password-store=basic", "--window-size=1100,850", "--no-sandbox", "about:blank"]
        step("Launch fresh native Vivaldi profile with loopback CDP")
        with log.open("w") as output:
            process = subprocess.Popen(launch, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        cdp = None
        try:
            endpoint = await debugger_url(profile, process, log)
            async with connect(endpoint, proxy=None, origin=None, open_timeout=10, close_timeout=3,
                               max_size=8 * 1024 * 1024) as socket:
                cdp = CDP(socket, origin)
                try:
                    return await exercise(cdp, build, args, origin, publisher_requests)
                except Exception:
                    with contextlib.suppress(Exception):
                        print("[vivaldi] targets: " + json.dumps(await cdp.command("Target.getTargets", timeout=3)), flush=True)
                    print("[vivaldi] runtime errors: " + json.dumps(cdp.errors), flush=True)
                    print("[vivaldi] unexpected requests: " + json.dumps(cdp.unexpected), flush=True)
                    raise
                finally:
                    with contextlib.suppress(Exception):
                        await cdp.command("Browser.close", timeout=3)
                    await cdp.close()
        except Exception:
            print("[vivaldi] browser log tail:\n" + log.read_text(errors="replace")[-6000:], flush=True)
            raise
        finally:
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--browser", default=os.getenv("LABEL_TEST_BROWSER"), required=not os.getenv("LABEL_TEST_BROWSER"))
    parser.add_argument("--install-only", action="store_true")
    parser.add_argument("--pregrant-test-origin", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if not args.install_only and not args.pregrant_test_origin:
        parser.error("Full acceptance requires --pregrant-test-origin; use --install-only for the unmodified package")
    try:
        result = asyncio.run(run(args))
        result["passed"] = True
    except Exception as error:
        result = {"passed": False, "native_browser": "Vivaldi", "failed_step": CURRENT_STEP,
                  "error": f"{type(error).__name__}: {error}"[:4000]}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
