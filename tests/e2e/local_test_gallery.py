"""Exercise real unsigned images through the separate Local Test extension."""
import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.test_gallery import gallery
from browser_test import browser_session, wait_for_registration


def wait_for_label(page, selector, expected, timeout=45_000):
    page.locator(selector).scroll_into_view_if_needed()
    page.wait_for_function(
        """([selector, expected]) => {
          const target = document.querySelector(selector);
          if (!target?.complete || !target.naturalWidth) return false;
          const rect = target.getBoundingClientRect();
          const badges = [...document.querySelectorAll('label-ai-overlay')]
            .flatMap(host => [...host.shadowRoot.querySelectorAll('.slop-label')]);
          const attached = badges.some(badge => {
            const box = badge.getBoundingClientRect();
            return Math.abs(box.left - Math.max(0, rect.left) - 8) < 3 &&
              Math.abs(box.top - Math.max(0, rect.top) - 8) < 3;
          });
          return attached === expected;
        }""",
        arg=[selector, expected], timeout=timeout,
    )


def actual_decision(worker, selector):
    """Run the real extension inference message on the selected rendered image."""
    return worker.evaluate(
        """async selector => {
          const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
          const [response] = await chrome.scripting.executeScript({
            target:{tabId:tab.id},args:[selector],func:async selector => {
              const img=document.querySelector(selector);
              const canvas=document.createElement('canvas');
              canvas.width=img.naturalWidth; canvas.height=img.naturalHeight;
              const context=canvas.getContext('2d');
              context.drawImage(img,0,0);
              const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
              let data='';
              for(let i=0;i<pixels.length;i+=4096)
                data+=String.fromCharCode(...pixels.subarray(i,i+4096));
              return await chrome.runtime.sendMessage({
                type:'label-ai:analyze',kind:'image',generation:0,
                instanceId:'test-gallery-runtime',requestId:crypto.randomUUID(),
                frame:{width:canvas.width,height:canvas.height,timestampMs:0,rgba:btoa(data)}
              });
            }
          });
          return response.result;
        }""", selector,
    )


def run(build, production=False):
    build = build.resolve()
    manifest = json.loads((build / "manifest.json").read_text())
    expected_name = "Label.ai" if production else "Label.ai (Local Test)"
    assert manifest["name"] == expected_name, f"expected {expected_name} package"
    expected_hosts = {"http://*/*","https://*/*"} if production else {
        "http://localhost/*", "http://127.0.0.1/*"
    }
    assert set(manifest.get("host_permissions", [])) == expected_hosts
    assert not manifest.get("optional_host_permissions")
    with gallery() as (origin, requests), TemporaryDirectory() as profile, sync_playwright() as pw:
        args = argparse.Namespace(browser=None)
        launch = ["--disable-extensions-except=" + str(build), "--load-extension=" + str(build),
                  "--disable-background-networking", "--disable-component-update", "--disable-sync",
                  "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"]
        forbidden = []
        with browser_session(pw, profile, launch, args) as context:
            def record_request(request):
                if request.url.startswith(("http://", "https://", "ws://", "wss://")):
                    path = request.url.removeprefix(origin)
                    expected = request.url.startswith(origin + "/") and (
                        path in {"/", "/gallery.js", "/gallery.css"} or path.startswith("/assets/")
                    )
                    if not expected or request.method not in {"GET", "HEAD"} or "?" in request.url:
                        forbidden.append([request.method, request.url.split("?")[0]])
            context.on("request", record_request)
            worker = wait_for_registration(context, build)
            site = context.new_page()
            site.bring_to_front()
            site.goto(origin)
            wait_for_label(site, "#signed", True)
            if not production:
                wait_for_label(site, "#generated-1", True)
            if production:
                site.locator("#generated-1").scroll_into_view_if_needed()
                result = actual_decision(worker, "#generated-1")
                assert result["status"] == "COMPLETED" and result["shouldLabel"] is False, result
                wait_for_label(site, "#generated-1", False)
                assert not forbidden, forbidden
                assert all(method in {"GET", "HEAD"} for method, _ in requests), requests
                return {"production_unsigned_abstention": True, "unexpected_requests": forbidden}
            site.locator("#genuine-1").scroll_into_view_if_needed()
            # Wait for an actual completed inference on a known genuine input before
            # asserting no badge; an instant empty overlay would not prove abstention.
            result = actual_decision(worker, "#genuine-1")
            assert result["status"] == "COMPLETED" and not result["shouldLabel"], result
            wait_for_label(site, "#genuine-1", False)
            context.set_offline(True)
            # An already loaded generated asset must produce a fresh decision even
            # when the local test browser context has no connection.
            site.locator("#generated-1").scroll_into_view_if_needed()
            result = actual_decision(worker, "#generated-1")
            assert result["status"] == "COMPLETED" and result["shouldLabel"], result
            context.set_offline(False)
            # File selection renders a browser-owned object URL. The page never
            # submits a form or sends the selected bytes to the loopback server.
            source = ROOT / "artifacts/smoke-media/4e1f3d61-f913-4f25-a866-d2c434045d38.png"
            site.locator("#local-files").set_input_files(source)
            wait_for_label(site, "#local-media-1", True)
            assert site.locator("#local-media-1").get_attribute("src").startswith("blob:")
            site.locator("#clear-local").click()
            assert site.locator("#local-media-1").count() == 0
            assert not forbidden, forbidden
            assert all(method in {"GET", "HEAD"} for method, _ in requests), requests
        return {"signed_positive": True, "unsigned_generated_positive": True,
                "genuine_negative": True, "local_file_positive": True, "offline_local_inference": True,
                "unexpected_requests": forbidden}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--production", action="store_true", help="Check that the ordinary package abstains on the same unsigned generated fixture")
    args = parser.parse_args()
    print(json.dumps(run(args.build, args.production)))
