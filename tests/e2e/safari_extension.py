"""Installed Safari WebExtension checks using Apple's WebDriver Classic endpoints.

Both the install check and strict installed-overlay acceptance use the exact
shipping resources. Native browser permission and focus must be available;
the harness never pregrants hosts or injects a replacement scanner.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
from time import monotonic, sleep
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.demo_page import publisher

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
TEXT = "AI Slop Detected 🤮"


class SetupUnavailable(AssertionError):
    """Native origin discovery or permission prompting could not be exercised."""


def step(name, **details):
    print(json.dumps({"safari_extension_step": name, **details}, ensure_ascii=False), flush=True)


class Driver:
    def __init__(self, session, request):
        self.session, self.request = session, request

    def call(self, path, method="GET", body=None):
        return self.request(self.session + path, method, body)

    def script(self, source, *args):
        return self.call("/execute/sync", "POST", {"script": source, "args": list(args)})

    def async_script(self, source, *args):
        value = self.call("/execute/async", "POST", {
            "script": "const done=arguments[arguments.length-1]; const args=Array.from(arguments).slice(0,-1);"
                      "Promise.resolve().then(async()=>{" + source + "}).then("
                      "value=>done({ok:true,value}),error=>done({ok:false,error:String(error).slice(0,500)}));",
            "args": list(args),
        })
        if not isinstance(value, dict) or not value.get("ok"):
            raise AssertionError(f"Extension script failed: {value}")
        return value.get("value")

    def wait(self, name, check, timeout=15):
        deadline = monotonic() + timeout
        last = None
        while monotonic() < deadline:
            last = check()
            if last:
                return last
            sleep(.25)
        raise AssertionError(f"Timed out after {timeout}s: {name}; last={str(last)[:200]}")

    def navigate(self, url):
        self.call("/url", "POST", {"url": url})

    def switch(self, handle):
        self.call("/window", "POST", {"handle": handle})

    def element(self, value, using="css selector"):
        return self.call("/element", "POST", {"using": using, "value": value})[ELEMENT]

    def click(self, value, using="css selector"):
        element = self.element(value, using)
        self.call("/element/" + quote(element, safe="") + "/click", "POST", {})

    def button(self, text):
        self.click("//button[normalize-space(.)=" + json.dumps(text) + "]", "xpath")


BADGES = """
const nodes=[];
for(const host of document.querySelectorAll('label-ai-overlay'))
  for(const node of host.shadowRoot?.querySelectorAll('.slop-label')??[]) {
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    if(rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.display!=='none')
      nodes.push({text:node.textContent.replace(/\\s+/g,' ').trim(),pointerEvents:style.pointerEvents});
  }
return nodes;
"""


def badge_count(driver, count, timeout=40):
    def check():
        nodes = driver.script(BADGES)
        if len(nodes) != count:
            return False
        assert all(node["text"] == TEXT for node in nodes), nodes
        assert all(node["pointerEvents"] == "none" for node in nodes), nodes
        return {"count": count}
    driver.wait(f"exactly {count} genuine shadow-root badges", check, timeout)


def stays_unlabeled(driver, seconds=2):
    deadline = monotonic() + seconds
    while monotonic() < deadline:
        assert driver.script(BADGES) == [], "a stale or negative badge appeared"
        sleep(.2)


def diagnostics(driver):
    return driver.script("""
      return {url:location.protocol+'//'+location.host+location.pathname,
        focused:document.hasFocus(),hidden:document.hidden,
        overlays:document.querySelectorAll('label-ai-overlay').length,
        optionsStatus:document.querySelector('#site-heading') ? (document.querySelector('[role=status]')?.textContent||'').slice(0,300) : null,
        images:Array.from(document.images).slice(0,3).map(i=>({id:i.id,complete:i.complete,
          naturalWidth:i.naturalWidth,width:i.getBoundingClientRect().width,
          sourceScheme:(i.currentSrc||i.src).split(':')[0]}))};
    """)


def install(driver, build):
    step("install.begin")
    response = driver.call("/webextension", "POST", {"type": "path", "path": str(build.resolve())})
    # Safari 27 returns the WebDriver extension result object. The opaque id is
    # for uninstall; it is not necessarily the safari-web-extension URL host.
    identifier = response.get("extension") if isinstance(response, dict) else response
    if not isinstance(identifier, str) or not identifier or len(identifier) > 300:
        raise AssertionError(f"Unexpected WebExtension install identifier: {identifier!r}")
    step("install.complete", identifier=identifier)
    return identifier


def uninstall(driver, identifier):
    try:
        driver.call("/webextension/" + quote(identifier, safe=""), "DELETE")
    except RuntimeError as error:
        message = str(error).lower()
        missing = message.startswith("safaridriver 404:") and any(
            code in message for code in ("no such extension", "no such web extension", "unknown extension"))
        if not missing or not re.search(r"%[0-9a-fA-F]{2}", identifier):
            raise
        # Apple's opaque UNSIGNED ids can contain a pre-escaped %20. Retry once
        # only for the specific not-found outcome, retaining existing escapes.
        step("uninstall.retry_existing_url_escape")
        driver.call("/webextension/" + quote(identifier, safe="%()"), "DELETE")
    step("uninstall.complete")


def options_ready(driver):
    return driver.script("return document.querySelector('#site-heading')?.textContent==='Automatic scanning' && Boolean((globalThis.browser||globalThis.chrome)?.runtime?.id);")


def open_original_options(driver, identifier, options_path):
    # Prefer an actual option tab if Safari exposed one in this session. The
    # vendor install ID can be opaque and must not be treated as an origin.
    for handle in driver.call("/window/handles"):
        driver.switch(handle)
        parsed = urlsplit(driver.call("/url"))
        if (parsed.scheme in ("safari-web-extension", "webkit-extension")
                and parsed.path == "/" + options_path.lstrip("/") and options_ready(driver)):
            return handle
    if not re.fullmatch(r"[A-Za-z0-9._-]+", identifier):
        raise SetupUnavailable(
            "SafariDriver returned an opaque installation identifier and no genuine options tab. "
            "Complete the native global pause/resume walkthrough in an interactive Safari window."
        )
    try:
        driver.navigate(f"safari-web-extension://{identifier}/{options_path}")
        driver.wait("unmodified extension options page", lambda: options_ready(driver), 8)
    except (AssertionError, RuntimeError) as error:
        raise SetupUnavailable(str(error)) from error
    return driver.call("/window")


def start_model_check(driver, options, origin):
    """Send an actual request from the fixture's isolated content world, not options."""
    driver.switch(options)
    result = driver.async_script("""
      const api=globalThis.browser||globalThis.chrome, origin=args[0];
      const tabs=await api.tabs.query({});
      const tab=tabs.find(t=>t.url?.startsWith(origin+'/'));
      if(!tab)throw new Error('Fixture tab unavailable to the granted extension');
      const win=await api.windows.get(tab.windowId);
      if(tab.incognito)throw new Error('Fixture tab is incognito; production guard forbids analysis');
      setTimeout(()=>{
        void api.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
          try {
            const deadline=performance.now()+10000;
            while((document.hidden||!document.hasFocus()) && performance.now()<deadline)
              await new Promise(r=>setTimeout(r,100));
            if(document.hidden||!document.hasFocus())throw new Error('Fixture did not regain focus');
            const control=document.querySelector('#control'),canvas=document.createElement('canvas');
            canvas.width=160;canvas.height=160;
            const ctx=canvas.getContext('2d');ctx.drawImage(control,0,0,160,160);
            const pixels=ctx.getImageData(0,0,160,160).data;
            let raw='';for(let i=0;i<pixels.length;i+=4096)raw+=String.fromCharCode(...pixels.subarray(i,i+4096));
            const api=globalThis.browser||globalThis.chrome;
            const result=await api.runtime.sendMessage({type:'label-ai:analyze',kind:'image',generation:0,
              instanceId:'safari-smoke-control',requestId:crypto.randomUUID(),
              frame:{width:160,height:160,timestampMs:0,rgba:btoa(raw)}});
            document.documentElement.dataset.labelAiOnnx=JSON.stringify(result);
          } catch(error) {document.documentElement.dataset.labelAiOnnx=JSON.stringify({error:String(error).slice(0,300)});}
        }}).catch(error=>{globalThis.labelAiSafariInjectionError=String(error).slice(0,300);});
      },500);
      return {tabId:tab.id,incognito:tab.incognito===true,windowFocused:win.focused===true};
    """, origin)
    step("packaged_onnx.begin", sender=result)


def exercise_automatic_scan(driver, site, origin):
    # Visit an ordinary visible page immediately after installation. Native Safari
    # website access must already be granted; no extension UI actions precede
    # the first badge assertion.
    driver.switch(site)
    driver.navigate(origin + "/")
    driver.click("body")
    step("publisher.ready", state=diagnostics(driver))
    badge_count(driver, 1, 45)
    step("automatic_signed_badge.complete")
    driver.script("document.querySelector('#asset').src=document.querySelector('#control').src;")
    badge_count(driver, 0, 10)
    stays_unlabeled(driver)
    step("stale_and_negative.complete")
    driver.script("document.querySelector('#asset').src=globalThis.addressed;")
    badge_count(driver, 1, 45)
    step("content_addressed_badge.complete")
    driver.script("document.querySelector('#asset').src=document.querySelector('#control').src;")
    badge_count(driver, 0, 10)
    driver.script("document.querySelector('#asset').src=globalThis.signedSource;")
    badge_count(driver, 1, 40)
    driver.script("document.querySelector('#asset').remove();")
    badge_count(driver, 0, 10)
    step("detached_media.complete")
    driver.script("const image=document.createElement('img');image.id='asset';image.src=globalThis.signedSource;document.body.prepend(image);")
    badge_count(driver, 1, 40)
    return {"automatic_scanning": True, "signed_badge": True, "stale_removal": True,
            "unsigned_negative": True, "content_addressed_positive": True, "detached_media": True}


def read_controls(driver, origin):
    return driver.async_script("""
      const api=globalThis.browser||globalThis.chrome, url=new URL(args[0]);
      const pattern=url.protocol+'//'+url.hostname+'/*';
      const registered=(await api.scripting.getRegisteredContentScripts()).find(script=>script.id==='label-ai-media');
      return {settings:(await api.storage.local.get('localSettings')).localSettings||null,
              hostPermission:await api.permissions.contains({origins:[pattern]}),
              registrationMatches:registered?.matches||[],
              incognito:api.extension?.inIncognitoContext};
    """, origin)


def assert_settings(state, enabled):
    assert state["settings"] == {"enabled": enabled, "consentVersion": 2}, state
    assert state["hostPermission"] is True, state
    assert state.get("incognito") is False, state
    assert set(state["registrationMatches"]) == ({"http://*/*", "https://*/*"} if enabled else set()), state


def wait_status(driver, expected):
    driver.wait(expected, lambda: driver.script(
        "return document.querySelector('[role=status]')?.textContent===arguments[0];", expected), 12)


def exercise_controls(driver, options, site, origin):
    driver.switch(options)
    driver.wait("global scanning enabled by default", lambda: driver.script(
        "return document.body.textContent.includes('Automatic scanning is on.');"), 12)
    state = read_controls(driver, origin)
    if state["settings"] is not None:
        assert_settings(state, True)
    else:
        # A current install can derive enabled=true from defaults before any
        # storage write. The real automatic badge and options UI prove the state.
        assert state["hostPermission"] is True and state.get("incognito") is False, state
        assert set(state["registrationMatches"]) == {"http://*/*", "https://*/*"}, state
    step("automatic_settings.complete", state=state)
    start_model_check(driver, options, origin)
    driver.switch(site)
    driver.click("body")
    encoded = driver.wait("real packaged ONNX response", lambda: driver.script("return document.documentElement.dataset.labelAiOnnx||null;"), 50)
    reply = json.loads(encoded)
    assert reply and reply.get("status") == "COMPLETED" and reply.get("shouldLabel") is False, reply
    step("packaged_onnx.complete", result=reply)

    driver.switch(options)
    driver.button("Pause scanning")
    wait_status(driver, "Scanning paused. Existing labels have been removed.")
    assert_settings(read_controls(driver, origin), False)
    driver.switch(site)
    badge_count(driver, 0, 10)
    driver.call("/refresh", "POST", {})
    stays_unlabeled(driver)
    step("global_pause.complete")

    driver.switch(options)
    driver.button("Resume scanning")
    wait_status(driver, "Scanning resumed.")
    assert_settings(read_controls(driver, origin), True)
    driver.switch(site)
    driver.call("/refresh", "POST", {})
    driver.click("body")
    badge_count(driver, 1, 45)
    step("global_resume.complete")

    driver.switch(options)
    driver.button("Clear local data")
    wait_status(driver, "Local data cleared. Scanning remains paused.")
    assert_settings(read_controls(driver, origin), False)
    driver.switch(site)
    badge_count(driver, 0, 10)
    driver.call("/refresh", "POST", {})
    stays_unlabeled(driver)
    step("global_clear.complete")
    return {"packaged_onnx_status": reply["status"], "global_pause_resume": True,
            "global_clear": True, "native_host_permission_retained": True}


def cleanup(driver, identifier):
    try:
        uninstall(driver, identifier)
        return True
    except RuntimeError as error:
        # A vendor cleanup error does not undo an acknowledged installation.
        # The disposable SafariDriver session closes separately.
        step("uninstall.failed", error=str(error)[:300])
        return False


def run_install_smoke(session, request, build):
    """Require a genuine install acknowledgement for the exact shipped package."""
    build = build.resolve()
    manifest_path = build / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["name"] == "Label.ai"
    assert set(manifest.get("host_permissions", [])) == {"http://*/*", "https://*/*"}, manifest
    assert not manifest.get("optional_host_permissions"), manifest
    driver = Driver(session, request)
    identifier = install(driver, build)
    try:
        assert manifest_path.read_bytes() == manifest_bytes, "shipping package was modified"
        digest = hashlib.sha256(manifest_bytes).hexdigest()
        step("untouched_package.installed", manifest_sha256=digest)
    finally:
        cleaned = cleanup(driver, identifier)
    return {"unmodified_package_installed": True, "manifest_sha256": digest,
            "cleanup_completed": cleaned, "overlay_acceptance_exercised": False}


def run_extension(session, request, build):
    """Strict post-install scanning and global controls using the exact package."""
    build = build.resolve()
    manifest_bytes = (build / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["name"] == "Label.ai"
    assert set(manifest.get("host_permissions", [])) == {"http://*/*", "https://*/*"}, manifest
    assert not manifest.get("optional_host_permissions"), manifest
    options_path = manifest.get("options_ui", {}).get("page") or manifest.get("options_page")
    assert options_path, "shipping options page is missing"
    driver = Driver(session, request)
    driver.call("/timeouts", "POST", {"script": 35000, "pageLoad": 20000, "implicit": 0})
    identifier = None
    with publisher() as (origin, requests):
        try:
            identifier = install(driver, build)
            step("untouched_package.installed", manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest())
            site = driver.call("/window/new", "POST", {"type": "tab"})["handle"]
            result = exercise_automatic_scan(driver, site, origin)
            step("automatic_scan.complete", result=result)
            options = open_original_options(driver, identifier, options_path)
            step("untouched_options.complete")
            # Navigation used to discover options can replace a managed tab.
            if options == site:
                site = driver.call("/window/new", "POST", {"type": "tab"})["handle"]
                driver.switch(site)
                driver.navigate(origin + "/")
                driver.click("body")
                badge_count(driver, 1, 45)
            result.update(exercise_controls(driver, options, site, origin))
            unexpected = [(method, path) for method, path in requests if method != "GET" or "?" in path or not (path == "/" or path.startswith("/assets/"))]
            assert not unexpected, unexpected
            result.update({"unmodified_package_installed": True,
                           "publisher_unexpected_requests": unexpected,
                           "network_observation_scope": "loopback publisher requests; not browser-wide network capture"})
            step("all_checks.complete", result=result)
            return result
        except Exception:
            try:
                step("failure.diagnostics", state=diagnostics(driver))
            except Exception as diagnostic_error:
                step("failure.diagnostics_unavailable", error=str(diagnostic_error)[:300])
            raise
        finally:
            if identifier:
                cleanup(driver, identifier)
            assert (build / "manifest.json").read_bytes() == manifest_bytes, "shipping package was modified"
