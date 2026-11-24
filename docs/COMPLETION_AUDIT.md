# Completion audit — November 24, 2026

## Scope and current product

Label.ai runs locally as a WXT, Svelte 5 and SMUI extension. The supported desktop test matrix is Chromium, Google Chrome for Testing, Microsoft Edge, Brave and Opera. Safari has a separate WXT package and Apple host applications. Vivaldi is outside the project scope. At the audited revision, only approved visible pages were eligible; manual site selection was subsequently superseded by the owner’s automatic HTTP/HTTPS scanning requirement. In either case, and the page UI is the animated **AI Slop Detected 🤮** label. Media, URL and detector data are never uploaded to an analysis service.

The first development preview had working on-device inference and signed-image detection. The main production gap was that statistical evidence had not been established on independent, representative media. This audit also identified specific runtime and acceptance defects.

## Audit findings

| Area | Finding and disposition |
| --- | --- |
| Provenance decisions | A trusted initial creation event could still yield a whole-asset badge after editing or compositing. The verifier now abstains on ingredient-linked, explicitly incomplete and ambiguous action histories. The real signed JPEG fixture remains a positive. |
| Media acquisition | Embedded and narrowly scoped publisher JPEGs provided most original bytes. The expanded local routes cover eligible cached static PNGs and readable immutable same-origin Blob image/MP4 originals without sending media to a server. Transformed or unreadable sources remain subject to source-binding checks. |
| Worker and lifecycle | A rejected background request or a full queue could strand an item. Recovery is bounded per source; capture cancellation and current-source checks remain necessary throughout asynchronous work. |
| Visual behavior | A subsequent layout render could remove the entrance animation class before animation finished. The keyed badge now preserves its animation state until removal. |
| Site settings | Permission and registration failures previously had poor feedback. Options now report partial failures and check the browser's actual grant. |
| Privacy and frames | Explicit regular-tab state is required; iframe eligibility and private-context rules are enforced. Private routes and protected or unreadable media abstain. URL and DOM heuristics cannot establish that every page on an authenticated host is public. |
| Chromium verification | Previous native installations passed all five desktop jobs, including a 240-item scrolling feed, offline model execution and revocation. The extended suite exercises immutable Blob originals, video playback/poster abstention, ordinary browser-profile restart and scroll re-entry. Results on the latest revision determine acceptance. |
| Safari verification | Native Safari acknowledged exact-package installation and returned all six expected credential decisions. Xcode built both unsigned containing apps. The real options page loaded, but automated consent timed out; older simulator sessions did not establish a remote connection. The PR runs required native installation/verifier/host-build checks. Full installed-overlay and simulator checks remain separately available and their failures are reported. See [native acceptance](SAFARI_ACCEPTANCE.md). |
| Evaluation workflow | Build-time, local reference-corpus inference and reproducible calibration/evaluation tooling are required to turn real ONNX scores into a reviewable release policy. The 82-asset frontier development comparison exposed poor generalization on current generators. The production statistical policies remain disabled until a better calibrated detector meets the stated independent quality criteria. |

## Measured detector result

The pinned detector completed 82 local inferences (44 source groups). At its 0.99 diagnostic raw-score threshold it identified zero generated image renditions or clips. At 0.5, it crossed the threshold for four of 19 generated originals and two of 19 Instagram renditions, with zero of 19 genuine results in either slice. The lower-quartile video scores overlapped between generated and genuine clips. A second pinned 23 MB quantized ONNX image candidate (Slop Detect ViT-S) recognized two of 19 generated originals at raw 0.99. Its published 0.65 threshold recognized six of 19 and incorrectly flagged one of 19 genuine originals. Neither tested model has release evidence. This makes model generalization and independent validation the leading unresolved issue. [Full per-asset report](../ml/reports/frontier-dev-2026-10.json)

## Remaining production acceptance

- Establish rights, source independence and diversity for frozen representative image and video calibration/holdout datasets. Include artists' work, CGI, camera originals, modern generators, composites, edits, platform transformations and partial-video generation. Report projected precision, confidence bounds on false positives, and recall separately for images and full clips. A development benchmark cannot certify release accuracy.
- Obtain a qualifying trusted generated-video original and verify the full source-to-badge path, alongside ordinary camera footage and mixed clips. The existing Sora test is a verified negative outcome due to invalid signing credentials.
- Perform a complete Safari site grant, scan, cancellation, revocation and playback walkthrough in an ordinary macOS browser and on iPhone/iPad hardware. Complete device memory, latency and energy measurements and exercise session suspension. Use the same distributed resource set.
- Test publicly accessible pages on the priority websites, with real grants and fresh dates. Platform-specific streams, cross-origin images, transcoding, metadata removal, CSS backgrounds and private pages can reduce coverage.
- Complete store-specific permission and privacy review and publisher signing/distribution. Store publication is outside the authorized implementation work.

## Completion estimate

The browser-extension implementation and local inference infrastructure are usable as a development preview. Overall production completion is approximately 70% as an engineering estimate; detector validation and macOS/iOS installed-workflow acceptance carry substantial weight. It is unrelated to detection accuracy. A trusted, signed whole-asset generation record can authorize a badge. Without sufficient evidence about generated origin, the product abstains. See the latest [progress](PROGRESS.md), [compatibility](BROWSER_SUPPORT.md), [evaluation](EVALUATION.md) and [release gates](RELEASE_GATES.md).
