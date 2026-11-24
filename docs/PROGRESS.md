# Implementation and verification

This branch started from f390a4c, which contained the plan and specification but no extension or detector implementation. The development preview targets separate Chromium and Safari WebExtension packages. It runs inference and verifies signed credentials on device.

## Evidence

- The official C2PA WASM verifier labeled the signed Firefly example and rejected the tampered version, expired credential, unrelated trust root and unsigned image. The edited camera example received no generation label. Fixture verification used the same WASM binary as the extension with external fetch forbidden.
- The pinned image model ran on four generated and four camera images. Raw generated scores ranged from 0.99205 to 0.999999 and camera scores from 0.000517 to 0.06872. Each example was a developer smoke input. Independent images from unseen generators, artwork and mixed cases are needed before activation.
- Video testing decoded twelve frames per file on a generated Kling clip and camera footage encoded as MP4 and WebM. The generated video's lower-quartile frame score was approximately 0.656. The camera encodings were approximately 0.002. The trained temporal release policy and independently measured false-positive/recall bounds remain open. The two encodings are one source.
- Source, checksums, runtime, timings, representation and predictions are recorded under ml/reports and tests/fixtures. The model takes roughly 1.4–1.5 seconds per image on the development CPU. Browser and device timings can differ.
- Unit, policy, WASM, type checking and package verification are automated. CI builds both WXT targets. The browser jobs install the Chromium package and exercise permission, signed embedded and publisher image labeling, stale-source removal, reduced motion, offline inference and revocation. The macOS job converts the Safari target and compiles the macOS and iOS containing apps. Follow the PR checks for results on its exact revision.

## Packaged browser observations

On revision fd7b9d0, the Linux Chromium 151.0.7922.34, Google Chrome for Testing 158.0.8127.88, Microsoft Edge 158.0.4370.33, Brave 1.100.59 and Opera 140.0.6074.36 jobs each installed the unmodified extension. In a separate disposable profile with a loopback host grant, all five passed visible badge, signed publisher JPEG, withdrawn/stale badge, offline local ONNX execution, reduced-motion and revocation checks. No unexpected requests appeared in the monitored browser/publisher traffic. On the macOS runner, Xcode successfully compiled both the unsigned macOS app and the iOS simulator app. Native desktop Safari 27.2 returned all six expected credential decisions using Apple’s WebDriver and the actual packaged verifier. SafariDriver subsequently installed the unmodified package on desktop Safari. End-to-end confirmation of the installed overlay and site permissions, as well as physical iPhone/iPad behavior, is tracked separately. [Run and job logs](https://github.com/SZun/Label.ai/actions/runs/45495518360)

## Completion estimate

The audited preview covers approximately 70% of the original production goal. This engineering estimate weights general image/video detection and real-device behavior more heavily than scaffolding or passing unit tests. It is separate from accuracy. A signed, verifiable original can trigger a label today. Most media without usable credentials remains unlabeled because the public forensic routes lack independent release evidence.

## November 24 completion audit

The [audit](COMPLETION_AUDIT.md) records scanner fixes, expanded source-bound acquisition, interrupted-job recovery, frame and consent policy, a complete developer inference/calibration workflow and the independent Safari acceptance boundary. The previous required Chromium matrix at b7d139a passed all five desktop browsers. Its Safari job confirmed six actual credential decisions, unmodified installation and both Apple host builds; a separate disposable test copy opened the real options UI but timed out trying to activate the fixture origin. See [run 45501017688](https://github.com/SZun/Label.ai/actions/runs/45501017688). The latest required workflow separates exact Safari installation from the explicit strict installed-overlay/simulator run. See [Safari acceptance](SAFARI_ACCEPTANCE.md).

All 82 local ONNX executions in the October 2026 frontier development comparison completed, including 19 generated image sources and 19 genuine photo sources (originals and paired Instagram variants), and three generated plus three genuine clips. The existing raw-score threshold 0.99 recognized zero generated inputs. At 0.5 raw score, 4/19 generated originals and 2/19 generated Instagram variants crossed the threshold; 0/19 genuine renditions crossed in each slice. The video raw frame-score distributions overlapped. These small, uncalibrated, dependent development observations have no independent release significance and affirm that the production statistical gate must remain closed. See [actual benchmark results](../ml/reports/frontier-dev-2026-10.json).

## Automatic scanning and interactive testing

The owner superseded manual per-site selection with browser-wide HTTP/HTTPS installation access and global pause/resume. The separate Chromium Local Test package uses a compile-time experimental policy on HTTP loopback only, so unsigned media can exercise actual forensic labels without activating uncertified scores on public sites. The gallery serves pinned generated and genuine examples and allows local files to be displayed in browser-owned Blob URLs. See the README for commands. Earlier per-site grant test results above describe older revisions.

## Acceptance still open

Representative holdouts and licensed diversity, large-feed resource measurements, private versus public context ambiguity, real public-site performance, device-specific UI behavior and native Safari enable/grant/scan acceptance remain release work. Missing credentials and withheld statistical labels leave much of today's web content unlabeled. The package is a development preview.
