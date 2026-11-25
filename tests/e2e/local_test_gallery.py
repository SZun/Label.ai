"""Exercise the installed extension against known unsigned images and genuine controls."""
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
    page.locator(selector).evaluate("(element) => element.scrollIntoView({block: 'center'})")
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


def check_three_columns(page, origin):
    """The same pixels must produce three separately anchored, fully fitting badges."""
    page.goto(origin + "/columns")
    for width in (1000, 1200):
        if width == 1200:
            # Fixed descendants inside a transformed body use body coordinates.
            # The extension positions its overlay against the viewport.
            page.evaluate("document.body.style.transform = 'translateX(24px)'")
        page.set_viewport_size({"width": width, "height": 720})
        page.wait_for_function("""() => {
          const images = [...document.images];
          const badges = [...document.querySelectorAll('label-ai-overlay')]
            .flatMap(host => [...host.shadowRoot.querySelectorAll('.slop-label')]);
          if (images.length !== 3 || badges.length !== 3) return false;
          return images.every((image, column) => {
            const rect = image.getBoundingClientRect();
            const center = (rect.left + rect.right) / 2;
            return Math.floor(3 * center / innerWidth) === column && badges.some(badge => {
              const b = badge.getBoundingClientRect();
              return b.width > 0 && b.height > 0 &&
                Math.abs(b.left - rect.left) <= 12 && Math.abs(b.top - rect.top) <= 12 &&
                b.right <= rect.right + 1 && b.bottom <= rect.bottom + 1 &&
                getComputedStyle(badge).pointerEvents === 'none';
            });
          });
        }""", timeout=45_000)


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
                        path in {"/", "/columns", "/gallery.js", "/gallery.css"} or path.startswith("/assets/")
                    )
                    if not expected or request.method not in {"GET", "HEAD"} or "?" in request.url:
                        forbidden.append([request.method, request.url.split("?")[0]])
            context.on("request", record_request)
            worker = wait_for_registration(context, build)
            site = context.new_page()
            site.bring_to_front()
            site.goto(origin)
            wait_for_label(site, "#signed", True)
            mode = "production" if production else "local-test"
            site.locator(f'label-ai-overlay[data-label-ai-build="{mode}"]').wait_for(state="attached")
            for number in range(1, 5):
                wait_for_label(site, f"#generated-{number}", True)
                photo = f"#genuine-{number}"
                site.locator(photo).evaluate("(element) => element.scrollIntoView({block: 'center'})")
                # Wait for the scanner's actual completed inference before checking
                # the absence of a badge. An empty overlay alone proves nothing.
                site.locator(f'{photo}[data-label-ai-test-state="completed-no-label"]').wait_for(
                    state="attached", timeout=45_000)
                wait_for_label(site, photo, False)
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
            check_three_columns(site, origin)
            assert not forbidden, forbidden
            assert all(method in {"GET", "HEAD"} for method, _ in requests), requests
        return {"simultaneously_labeled_columns": ["left", "middle", "right"], "signed_positive": True, "unsigned_generated_labeled": 4,
                "genuine_completed_without_label": 4, "local_file_positive": True, "offline_local_inference": True,
                "unexpected_requests": forbidden}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--production", action="store_true", help="Exercise the regular all-sites package")
    args = parser.parse_args()
    print(json.dumps(run(args.build, args.production)))
