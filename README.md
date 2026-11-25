# Label.ai

Label.ai is a WXT browser extension that automatically scans visible images and playing videos on eligible HTTP and HTTPS pages in the active tab. The regular **Label.ai** build displays **AI Slop Detected 🤮** when it verifies a signed generation credential or its on-device model flags the media. The badge animates once and honors reduced motion. It has no tooltip, score or click action.

The 0.1.6 image policy caught 31 of 57 generated originals in a fresh comparison across 19 generators. Version 0.1.3 caught 15 of the same 57. The updated model cutoff also flagged one of 57 genuine photos, compared with zero previously. These counts measure image detection on this sample. Normal browsing also depends on whether the scanner can access the media. [Comparison and per-image results](ml/reports/frontier-browsing-sensitivity.json)

## Use the extension on the web

From the project root with Node.js 24 and Python 3 installed, build the regular extension. These commands use the project’s pinned pnpm and avoid invoking an older Corepack installation.

```sh
npm exec --yes --package=pnpm@11.25.0 -- make bootstrap
npm exec --yes --package=pnpm@11.25.0 -- pnpm run build:chrome
```

1. In a desktop Chromium browser, open the extensions manager. In Chrome this is `chrome://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/.output/chrome-mv3`. If you already loaded that directory, click **Reload** on its extension card. Disable **Label.ai (Local Test)** if installed.
2. Check that the card says **Label.ai** version **0.1.9** or later, website access is **On all sites**, and scanning is active. Open or refresh a public webpage. The extension scans as you scroll or watch video. There is no site list, server to start, or file to upload. Click the toolbar icon to see the current video’s scan status. **Scanning settings** opens global pause, resume and data controls.
3. The badge appears over eligible positive media. The model needs readable pixels, enough visible space for the badge, and sufficient consistent playback for video. Browser-internal pages, private contexts, DRM and cross-origin media whose pixels the browser protects are outside coverage. An unlabeled item has no authenticity verdict.

For Safari, run `npm exec --yes --package=pnpm@11.25.0 -- pnpm run build:safari`. On macOS select the unpacked `apps/extension/.output/safari-mv3` in **Add Temporary Extension…** in Safari’s developer settings where available. For an Apple containing app use `make safari-xcode` on a Mac with Xcode. Enable the extension and grant **All Websites** access in Safari. See [Safari acceptance](docs/SAFARI_ACCEPTANCE.md) for the verification status.

### Try a public video

Open [this exact two-second VideoCrafter2 MP4](https://ailab-cvc.github.io/videocrafter2/video/a_little_boy.mp4) in a regular Chrome tab. Right-click the player, enable **Loop**, and press Play. Keep the video visible. Chrome for Testing displayed a video-specific badge on this exact URL using the regular 0.1.8 extension. [Installed browser result](https://github.com/SZun/Label.ai/actions/runs/45529232468/job/138920279513)

The installed-Chrome [streaming playback test](https://github.com/SZun/Label.ai/actions/runs/45527174384/job/138913458066) joined an actively playing stream at 70 seconds, verified a badge from a video decision, and switched the same player to genuine camera footage. The badge cleared. The separate [social checks](https://github.com/SZun/Label.ai/actions/runs/45527174384) require a video-specific badge on each publisher’s actual player. A cover-image badge cannot pass.

Open the [VideoCrafter2 project page](https://ailab-cvc.github.io/videocrafter2/#results-carousel) in a regular Chrome tab. Scroll to the sample carousel and hover over the playing video to hold that slide in view. Press play if your browser paused it. The extension analyzes moving frames locally. Leave the player visible for a complete pass and allow time for inference. For ordinary short files watched from the start, the extension samples across the timeline. For buffered players of at least ten seconds, longer videos, readable live streams and clips joined partway through, it samples four seconds of visible playback and checks that the scene is still playing while inference runs. A positive window labels that scene. Skipping ahead or changing scenes retires its evidence. DRM-protected playback, unreadable frames and third-party iframe players remain coverage limits.

On a social feed, keep the video you want to check playing in the foreground. Click the extension icon to see whether the main page has a visible player, whether the scanner is waiting for frames, whether analysis is running, or whether the detector completed without enough evidence. Some social players decode video in a transparent element and paint it on a visible canvas. When the extension can identify a single matching canvas in that player, it samples the displayed canvas and ties the badge to that surface. The same scanner handles ordinary sites and social sites. A readable player can still carry generated footage the model misses.

Public posts can be scanned while signed out. If a social site requires an account to play the post, sign in on that site and play it normally. Label.ai uses the same on-device scan in both cases. The five-platform browser check covers YouTube, TikTok, Facebook, Instagram and X and supports signing in yourself in a temporary Chrome profile. [Run the live checks](docs/EVALUATION.md#five-platform-playback-acceptance)

### Try a public image

With the regular extension active, open the public [Keras textual inversion tutorial](https://keras.io/examples/generative/fine_tune_via_textual_inversion/#taking-the-fine-tuned-model-for-a-spin). Scroll to the first row of generated samples in **Taking the Fine Tuned Model for a Spin**. Keep that row in view while the model runs. Each row of three pictures in this tutorial is a single PNG and receives one badge for that whole image.

On Wikipedia, scroll to the three forest-and-shrine images under [Text to image generation](https://en.wikipedia.org/wiki/Stable_Diffusion#Text_to_image_generation). Their 250×125 thumbnails were previously too short for the detector. The [Image modification](https://en.wikipedia.org/wiki/Stable_Diffusion#Image_modification) section also has two generated city-sphere images.

### Optional repeatable check

To check video detection on a known sample, run `python3 tools/test_gallery.py --video-check` and open [the local video check](http://127.0.0.1:8765/). Play the five-second Luma Ray 3.2 clip from the beginning and keep the tab in front. It loops while the extension analyzes it. After the badge appears, pause Luma and play the MDN flower footage. Its scan should complete without a badge. The captions identify the source of each clip, and the status beneath each player reports the scanner's actual result.

Run `python3 tools/test_gallery.py --prepare` and open [the local gallery](http://127.0.0.1:8765) in the regular extension. Scroll through the signed Firefly cat, four unsigned Stable Diffusion images and four genuine photographs. The gallery reports the detected build and each item’s actual scanner state separately from its known origin. Add `--videos` to download the two optional clips. The local file picker displays files as browser object URLs.

To check left, middle and right placement, open [the three-column check](http://127.0.0.1:8765/columns) with the same server running. It displays one unsigned generated PNG in three independent image elements at different widths. On a desktop window, all three should have their own badge at the same time. The page reports the running build/version, scanner access, per-image result, and whether a badge is visible.

Developers who want to test loopback-only operation with an exploratory video threshold can run `npm exec --yes --package=pnpm@11.25.0 -- pnpm run build:chrome:test`. That separate **Label.ai (Local Test)** package is limited to HTTP loopback pages.

## What runs on the device

| Part | Responsibility |
| --- | --- |
| `apps/extension` | Automatic scanning, browser host access, visible-page discovery, bounded media capture, background jobs, source binding, privacy controls, and the Svelte 5 / SMUI overlay. |
| `packages/provenance` | Offline C2PA verification against packaged trust anchors, signed content binding and whole-asset creation scope. |
| `packages/detector`, `ml` | Local ONNX Runtime Web image inference, temporal video features, checksummed model provisioning, policy gates and developer measurements. |
| `tools`, `tests` | Evaluation, package auditing, reproducible ZIPs, browser acceptance tests, Apple packaging and generated test fixtures. |

No account or backend is required. Media, frames, addresses, hashes and model outputs are never sent to an analysis service. A qualifying content-addressed image can be read from the publisher using a credential-free GET. When a browser blocks direct pixel access, the scanner can read a public CDN image or a complete MP4/WebM using an anonymous GET if the publisher permits CORS. It analyzes only video times observed during visible playback. Visible photo cards that use a single supported CSS background can also be scanned using an anonymous read of the publisher’s image. These reads supply model estimates. An eligible same-origin JPEG or static PNG can be read from the browser cache after matching displayed pixels. Supported immutable same-origin Blob objects are read locally, including complete MP4 originals. The extension ignores remote credential references. See the [privacy description](docs/PRIVACY.md).

## Verify a build

```sh
make bootstrap
make verify
python3 -m pip install -r tests/e2e/requirements.txt
python3 -m playwright install chromium
make test-e2e
make package
```

Run `make safari-xcode` and `python3 tools/build_apple_host.py artifacts/safari-xcode` on macOS. The standalone browser test accepts `--browser /path/to/executable` to exercise the desktop browsers listed in the support matrix. The macOS CI job also runs the real signature verifier in native Safari through Apple’s WebDriver. Test the unmodified ZIP in a real profile before sharing it. The headless Chromium tests install the exact package with browser-wide host permissions and exercise automatic scanning across two distinct fixture origins, global pause/resume, and labeling.

[Specification](LABEL_AI_SPECIFICATION.md) · [Browser support](docs/BROWSER_SUPPORT.md) · [Safari acceptance](docs/SAFARI_ACCEPTANCE.md) · [Apple’s Safari testing guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) · [Progress and verification](docs/PROGRESS.md) · [Completion audit](docs/COMPLETION_AUDIT.md) · [Release gates](docs/RELEASE_GATES.md) · [Requirements](docs/REQUIREMENTS_TRACEABILITY.md) · [Evaluation](docs/EVALUATION.md)
