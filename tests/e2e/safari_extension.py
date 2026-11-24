"""Installed Safari WebExtension checks using Apple's WebDriver Classic endpoints.

No product modules or detector policy are modified. A disclosed, disposable
manifest/bootstrap copy can supply only the loopback fixture grant and an options
tab when SafariDriver cannot interact with a native permission prompt.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.demo_page import publisher

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
TEXT = "AI Slop Detected 🤮"


class SetupUnavailable(AssertionError):
    """Only origin discovery or native permission interaction may use a test copy."""


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
        images:Array.from(document.images).slice(0,3).map(i=>({id:i.id,complete:i.complete,
          naturalWidth:i.naturalWidth,width:i.getBoundingClientRect().width,
          sourceScheme:(i.currentSrc||i.src).split(':')[0]}))};
    """)


def install(driver, build, modified=False):
    step("install.begin", modified_test_copy=modified)
    response = driver.call("/webextension", "POST", {"type": "path", "path": str(build.resolve())})
    # Safari 27 returns the WebDriver extension result object. The opaque id is
    # for uninstall; it is not necessarily the safari-web-extension URL host.
    identifier = response.get("extension") if isinstance(response, dict) else response
    if not isinstance(identifier, str) or not identifier or len(identifier) > 300:
        raise AssertionError(f"Unexpected WebExtension install identifier: {identifier!r}")
    step("install.complete", identifier=identifier, modified_test_copy=modified)
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
    return driver.script("return document.querySelector('#site-heading')?.textContent==='Site access' && Boolean((globalThis.browser||globalThis.chrome)?.runtime?.id);")


def open_original_options(driver, identifier, options_path):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", identifier):
        raise SetupUnavailable("Install identifier does not directly identify a Safari extension origin")
    try:
        driver.navigate(f"safari-web-extension://{identifier}/{options_path}")
        driver.wait("unmodified extension options page", lambda: options_ready(driver), 8)
    except (AssertionError, RuntimeError) as error:
        raise SetupUnavailable(str(error)) from error
    return driver.call("/window")


def disposable_copy(build, destination, manifest):
    """Only test setup changes: one fixture host and opening the genuine options UI."""
    shutil.copytree(build, destination)
    copied = json.loads(json.dumps(manifest))
    pattern = "http://127.0.0.1/*"
    copied["host_permissions"] = list(dict.fromkeys(copied.get("host_permissions", []) + [pattern]))
    copied["optional_host_permissions"] = [p for p in copied.get("optional_host_permissions", []) if p != pattern]
    background = copied.get("background", {})
    worker = background.get("service_worker")
    if not worker or not (destination / worker).is_file():
        raise AssertionError("Expected the shipping MV3 service worker")
    prefix = "import " + json.dumps("./" + worker) + ";\n" if background.get("type") == "module" else "importScripts(" + json.dumps(worker) + ");\n"
    bootstrap = "label-ai-webdriver-bootstrap.js"
    (destination / bootstrap).write_text(prefix + """
const labelAiWebDriverApi=globalThis.browser||globalThis.chrome;
labelAiWebDriverApi.runtime.onInstalled.addListener(()=>{
  void labelAiWebDriverApi.tabs.create({url:labelAiWebDriverApi.runtime.getURL('/options.html')});
});
""")
    copied["background"]["service_worker"] = bootstrap
    discovery = "label-ai-webdriver-discovery.js"
    (destination / discovery).write_text("""
const labelAiWebDriverApi=globalThis.browser||globalThis.chrome;
document.documentElement.dataset.labelAiOptionsUrl=labelAiWebDriverApi.runtime.getURL('/options.html');
""")
    copied["content_scripts"] = copied.get("content_scripts", []) + [{
        "matches": [pattern], "js": [discovery], "run_at": "document_idle", "all_frames": False,
    }]
    (destination / "manifest.json").write_text(json.dumps(copied))
    assert copied.get("incognito") == manifest.get("incognito"), "private-browsing policy changed"
    assert (destination / worker).read_bytes() == (build / worker).read_bytes(), "product worker changed"
    return destination


def find_opened_options(driver, origin):
    def find():
        for handle in driver.call("/window/handles"):
            driver.switch(handle)
            url = driver.call("/url")
            parsed = urlsplit(url)
            if parsed.scheme in ("safari-web-extension", "webkit-extension") and parsed.path.endswith("/options.html"):
                if options_ready(driver):
                    return handle
        return None
    try:
        return driver.wait("test install opened the genuine options page", find, 5)
    except AssertionError:
        # A tabs.create tab may not belong to SafariDriver's managed window.
        # A loopback-only test script publishes only runtime.getURL; navigate
        # the real options page in a managed WebDriver tab instead.
        step("test_copy_options.discovery", disclosure="Loopback-only test content script exposes only the genuine options URL; it performs no analysis and changes no product guard.")
        handle = driver.call("/window/new", "POST", {"type": "tab"})["handle"]
        driver.switch(handle)
        driver.navigate(origin + "/")
        url = driver.wait("loopback test options URL discovery", lambda: driver.script("return document.documentElement.dataset.labelAiOptionsUrl||null;"), 12)
        parsed = urlsplit(url)
        assert parsed.scheme in ("safari-web-extension", "webkit-extension") and parsed.path == "/options.html" and not parsed.query and not parsed.fragment, "Unexpected discovered options URL"
        driver.navigate(url)
        driver.wait("genuine options in managed automation tab", lambda: options_ready(driver), 10)
        return handle


def request_consent(driver, options, origin):
    driver.switch(options)
    private = driver.script("return (globalThis.browser||globalThis.chrome).extension?.inIncognitoContext===true;")
    step("options.context", incognito=private)
    assert not private, "SafariDriver extension context is private; production guard must remain active"
    element = driver.element("#site")
    driver.call("/element/" + quote(element, safe="") + "/clear", "POST", {})
    driver.call("/element/" + quote(element, safe="") + "/value", "POST", {"text": origin})
    assert driver.script("return document.querySelector('#site').value") == origin, "SafariDriver did not enter the fixture origin"
    driver.button("Enable on this site")
    def consent():
        message = driver.script("return document.querySelector('[role=status]')?.textContent||''")
        if "not granted" in message:
            raise SetupUnavailable("Native site permission was not granted")
        return "Local analysis enabled." in message
    try:
        driver.wait("real options consent handler", consent, 12)
    except (AssertionError, RuntimeError) as error:
        raise SetupUnavailable(str(error)) from error
    driver.wait("registered production content script", lambda: driver.async_script("const api=globalThis.browser||globalThis.chrome; return (await api.scripting.getRegisteredContentScripts()).some(s=>s.id==='label-ai-media');"), 12)
    state = driver.async_script("const api=globalThis.browser||globalThis.chrome; return {permissions:await api.permissions.getAll(),settings:(await api.storage.local.get('localSettings')).localSettings,incognito:api.extension?.inIncognitoContext,tabs:(await api.tabs.query({})).filter(t=>t.url?.startsWith(args[0]+'/')).map(t=>({id:t.id,incognito:t.incognito,active:t.active}))};", origin)
    assert state["settings"]["enabled"] and origin in state["settings"]["approvedOrigins"], state
    assert state.get("incognito") is not True, "SafariDriver extension context is private; production guard must remain active"
    step("consent.complete", state=state)
    assert not any(tab.get("incognito") for tab in state["tabs"]), "SafariDriver fixture tab is private; production guard must remain active"


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


def exercise(driver, options, site, origin, requests, modified):
    driver.switch(site)
    driver.call("/refresh", "POST", {})
    driver.click("body")
    step("publisher.ready", state=diagnostics(driver))
    badge_count(driver, 1, 45)
    step("signed_badge.complete")
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
    start_model_check(driver, options, origin)
    driver.switch(site)
    driver.click("body")
    encoded = driver.wait("real packaged ONNX response", lambda: driver.script("return document.documentElement.dataset.labelAiOnnx||null;"), 50)
    reply = json.loads(encoded)
    assert reply and reply.get("status") == "COMPLETED" and reply.get("shouldLabel") is False, reply
    step("packaged_onnx.complete", result=reply)
    driver.script("document.querySelector('#asset').remove();")
    badge_count(driver, 0, 10)
    step("detached_media.complete")
    driver.script("const image=document.createElement('img');image.id='asset';image.src=globalThis.signedSource;document.body.prepend(image);")
    badge_count(driver, 1, 40)
    driver.switch(options)
    driver.click('button[aria-label="Remove ' + origin + '"]')
    driver.wait("revocation unregistered production scripts", lambda: driver.async_script("const api=globalThis.browser||globalThis.chrome; return (await api.scripting.getRegisteredContentScripts()).every(s=>s.id!=='label-ai-media');"), 12)
    revoked = driver.async_script("const api=globalThis.browser||globalThis.chrome;return {settings:(await api.storage.local.get('localSettings')).localSettings,hostPermission:await api.permissions.contains({origins:['http://127.0.0.1/*']})};")
    assert origin not in revoked["settings"]["approvedOrigins"], revoked
    if not modified:
        assert revoked["hostPermission"] is False, revoked
    driver.switch(site)
    badge_count(driver, 0, 10)
    driver.call("/refresh", "POST", {})
    stays_unlabeled(driver)
    step("revocation.complete", browser_host_permission_removed=not revoked["hostPermission"], local_consent_removed=True)
    unexpected = [(method, path) for method, path in requests if method != "GET" or "?" in path or not (path == "/" or path.startswith("/assets/"))]
    assert not unexpected, unexpected
    return {"signed_badge": True, "stale_removal": True, "unsigned_negative": True,
            "content_addressed_positive": True, "detached_media": True,
            "packaged_onnx_status": reply["status"], "local_consent_revocation": True,
            "browser_host_permission_removed": not revoked["hostPermission"],
            "publisher_unexpected_requests": unexpected,
            "network_observation_scope": "loopback publisher requests; not browser-wide network capture"}


def run_extension(session, request, build):
    build = build.resolve()
    manifest_bytes = (build / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["name"] == "Label.ai"
    options_path = manifest.get("options_ui", {}).get("page") or manifest.get("options_page")
    assert options_path, "shipping options page is missing"
    driver = Driver(session, request)
    driver.call("/timeouts", "POST", {"script": 35000, "pageLoad": 20000, "implicit": 0})
    identifier = None
    modified = False
    untouched_options = False
    with publisher() as (origin, requests), TemporaryDirectory(prefix="label-ai-safari-test-") as temporary:
        try:
            identifier = install(driver, build)
            step("untouched_package.installed", manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest())
            try:
                options = open_original_options(driver, identifier, options_path)
                untouched_options = True
                step("untouched_options.complete")
                site = driver.call("/window/new", "POST", {"type": "tab"})["handle"]
                driver.switch(site)
                driver.navigate(origin + "/")
                badge_count(driver, 0, 5)
                request_consent(driver, options, origin)
            except SetupUnavailable as error:
                step("test_setup_fallback", reason=str(error)[:500],
                     disclosure="Disposable copy adds only loopback host grant, onInstalled options bootstrap, and loopback-only options URL discovery; production scripts, detector checks and private-browsing guards stay intact.")
                uninstall(driver, identifier)
                identifier = None
                copied = disposable_copy(build, Path(temporary) / "extension", manifest)
                modified = True
                identifier = install(driver, copied, modified=True)
                options = find_opened_options(driver, origin)
                step("test_copy_options.complete")
                site = driver.call("/window/new", "POST", {"type": "tab"})["handle"]
                driver.switch(site)
                driver.navigate(origin + "/")
                badge_count(driver, 0, 5)
                request_consent(driver, options, origin)
            result = exercise(driver, options, site, origin, requests, modified)
            result.update({"unmodified_package_installed": True, "unmodified_options": untouched_options,
                           "disposable_test_copy": modified, "native_optional_permission_grant": not modified})
            step("all_checks.complete", result=result)
            return result
        except Exception:
            try:
                step("failure.diagnostics", state=diagnostics(driver))
            except Exception as diagnostic_error:
                step("failure.diagnostics_unavailable", error=str(diagnostic_error)[:300])
            raise
        finally:
            assert (build / "manifest.json").read_bytes() == manifest_bytes, "shipping package was modified"
            if identifier:
                try:
                    uninstall(driver, identifier)
                except Exception as error:
                    step("uninstall.failed", error=str(error)[:300])
