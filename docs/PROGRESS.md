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

The preview covers roughly two thirds of the original production goal. This engineering estimate weights general image/video detection and real-device behavior more heavily than scaffolding or passing unit tests. It is separate from accuracy. A signed, verifiable original can trigger a label today. Most media without usable credentials remains unlabeled because the public forensic routes lack independent release evidence.

## Acceptance still open

Representative holdouts and licensed diversity, large-feed resource measurements, private versus public context ambiguity, real public-site performance, device-specific UI behavior and native Safari enable/grant/scan acceptance remain release work. Missing credentials and withheld statistical labels leave much of today's web content unlabeled. The package is a development preview.
