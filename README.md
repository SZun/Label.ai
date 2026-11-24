# Label.ai

Label.ai is a WXT browser extension that scans visible media on sites you enable. When it can verify a signed declaration that the visual was AI-generated, it adds **AI Slop Detected 🤮** to the upper-left corner. There is one brief animation, with a static version for people who prefer reduced motion. The badge has no tooltip, score or click action.

This is a development preview for desktop Chromium-family browsers and Safari. Most social-network images and videos do not expose an intact, verifiable credential to an extension. Such media may stay unlabeled. The included local image and video analysis code is experimental. Its scores cannot currently create a public label. A missing label conveys no information about authenticity.

## Try the development build

1. Install Node.js 24, pnpm 11.25.0 and Python 3.12. Clone this repository and check out the development branch or its merged successor.
2. Run `make bootstrap` and `make build`. The first bootstrap downloads pinned development dependencies, model weights and test fixtures. Browser analysis runs locally with package resources.
3. In a desktop Chromium browser with unpacked extension support, open its extensions manager, enable Developer mode, choose **Load unpacked** and select `apps/extension/.output/chrome-mv3`. The ZIP made by `make package` contains the same directory contents. Extract it before loading.
4. Click the extension toolbar icon. Enter a public HTTPS site in **Site address**, choose **Enable on this site**, approve the browser prompt and reload the page. The privacy page also lets you pause, remove individual grants, and clear local settings.
5. For a temporary macOS Safari install, use **Add Temporary Extension…** in Safari’s developer settings and select the unpacked `safari-mv3` directory. For an Apple containing app, run `make safari-xcode` on a Mac with Xcode to create the containing apps. Build the macOS app or the iOS app for a simulator/device in Xcode, then enable the extension in Safari settings and grant site access. The Safari ZIP contains WebExtension resources for packaging. See the compatibility and release documents before distribution.

### Try a known positive

After bootstrap, run `python3 tools/demo_page.py` and open `http://127.0.0.1:8765`. Enable that exact address in Label.ai and reload the page. The tabby cat carries a signed Adobe Firefly creation record and should receive the badge. The conventional gradient should stay unlabeled. The server binds to loopback and only serves sample media. Press Ctrl+C to close it.

## What runs on the device

| Part | Responsibility |
| --- | --- |
| `apps/extension` | Site grants, visible-page discovery, bounded media capture, background jobs, source binding, privacy controls, and the Svelte 5 / SMUI overlay. |
| `packages/provenance` | Offline C2PA verification against packaged trust anchors, signed content binding and whole-asset creation scope. |
| `packages/detector`, `ml` | Local ONNX Runtime Web image inference, temporal video features, checksummed model provisioning, policy gates and developer measurements. |
| `tools`, `tests` | Evaluation, package auditing, reproducible ZIPs, browser acceptance tests, Apple packaging and generated test fixtures. |

No account or backend is required. Media, frames, addresses, hashes and model outputs are never sent to an analysis service. A qualifying content-addressed image can be read from the publisher using a credential-free GET. An ordinary eligible JPEG can be read from the browser cache under bounded conditions. The extension ignores remote credential references. See the [privacy description](docs/PRIVACY.md).

## Verify a build

```sh
make bootstrap
make verify
python3 -m pip install -r tests/e2e/requirements.txt
python3 -m playwright install chromium
make test-e2e
make package
```

Run `make safari-xcode` and `python3 tools/build_apple_host.py artifacts/safari-xcode` on macOS. The standalone browser test accepts `--browser /path/to/executable` to exercise alternative Chromium-family engines. Vivaldi uses its own native DevTools harness in `tests/e2e/vivaldi_test.py`. The macOS CI job also runs the real signature verifier in native Safari through Apple’s WebDriver. Test the unmodified ZIP in a real profile before sharing it. The headless loopback test uses a temporary copy with a pregranted fixture origin to exercise the permission and labeling flow.

[Specification](LABEL_AI_SPECIFICATION.md) · [Browser support](docs/BROWSER_SUPPORT.md) · [Apple’s Safari testing guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) · [Progress and verification](docs/PROGRESS.md) · [Release gates](docs/RELEASE_GATES.md) · [Requirements](docs/REQUIREMENTS_TRACEABILITY.md) · [Evaluation](docs/EVALUATION.md)
