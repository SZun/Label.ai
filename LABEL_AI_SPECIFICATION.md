# Label.ai product and engineering specification

This is the current implementation contract. The [original proposal](docs/history/2026-11-24-original-proposal.md) preserves the initial 64 acceptance IDs. Its **upload, remote inference, backend, database and Chrome-only requirements are superseded** by the owner's local detection and browser compatibility decisions. Its testing and quality requirements continue to apply to the local product. See the [architecture decision](docs/decisions/0001-local-analysis.md) and [requirement ledger](docs/REQUIREMENTS_TRACEABILITY.md).

## The experience

After the user enables access on a site, automatically inspect visible images and videos on the active page. Add exactly one noninteractive Material-style pill reading **AI Slop Detected 🤮** on a supported, confidently positive item. Position it at the upper left, clear of controls. Animate its entrance and brief red accent once per source, then settle to charcoal. Honor reduced motion, retain readable contrast, allow pointer events through and avoid layout shifts. Provide only the permission/privacy controls needed to enable or withdraw local analysis. No tooltips, score, dashboard or extra controls on the host page.

Treat fully or substantially generated visuals as eligible positives. Edits, CGI, a generated thumbnail, a short generated intro, uncertain composites, inaccessible inputs and errors must not cause a whole-asset label. Absence of a label conveys no verdict.

## Privacy and scope

All decisions take place on the user's device. The extension has no upload endpoint. No browser-derived data or diagnostics may be sent for analysis. Bundle scripts, WASM, models, trust settings and policy. Do not use media-dependent network requests to discover manifests, validate watermarks or report errors. Ephemeral local buffers and optional bounded versioned local caches are permitted. Never store a browsing history. See the architecture decision for publisher downloads and source binding.

Only analyze a visible, permitted page. Treat missing permission, incognito, private/sensitive contexts and uncertain acquisition conservatively. No browser debugger, tab recording, cookies or credential replay. The active media and its current source must match throughout the job, including after async inference. Cancel obsolete work and delete associated overlays immediately.

## Architecture and compatibility

WXT, TypeScript, Svelte 5 and Svelte Material UI form the browser extension. Produce separate Chromium and Safari manifests and artifacts. Use feature checks and local CPU/WASM execution where GPU support is unavailable. Bound active jobs, pixels, video frames, time, model memory, and queued media. Loading a page must not start an unbounded reader, block playback or require any external analysis service.

Discover dynamic images, responsive sources, videos and eligible backgrounds, open shadow roots and permitted frames. Prioritize visible media and clean up observers/queues on navigation, source changes, hidden tabs and permission changes. For video, sample permitted frames from multiple periods without seeking the visible player. A signed claim must apply to the active original and establish generation. Never assign original-file provenance to rendered pixels. Store metadata and model scores only locally if necessary. Unsupported inputs should abstain.

## Decisions and model quality

Implement embedded credential verification and real visual inference, with separate image- and video-level policies. Evaluate model/weight, backbone and dataset rights before redistribution. Pin artifacts by revision and hash. Never treat an arbitrary threshold, a single image score on a video frame, or unsigned metadata as sufficient to authorize a public label. Keep experimental policies separate from production. Cloud watermark verifiers are excluded. An offline watermark module requires actual access, licensing and validation before use.

Require independent tests on genuine photos, creator artwork, conventional CGI, synthetic images or clips, hybrid and edited content, unseen generators and browser-like transformations. Freeze policy and holdouts before evaluation. Report sample counts and confidence bounds for precision, FPR and coverage, and account for abstained positives in end-to-end recall. Proposed release criteria are 99% positive-label precision, at most 0.1% FPR and at least 50% eligible-generated forensic recall by modality. Report prevalence sensitivity and any failed or unverified gate. Runtime, performance and statistical acceptance are distinct.

## Engineering and delivery

Follow AGENTS.md and use test-first changes. The owner's implementation direction authorizes building the on-device version for Chromium browsers and Safari. Preserve traceability for superseded features. Run the extension in actual browsers, inspect the final manifest/resources and record exactly which installations passed.

Mandatory functional checks include offline real inference, zero upload attempts during successful and failed online analysis, an authentic media example left alone, stale-result rejection after DOM recycling, limited-resource cancellation and expiry, pointer and playback preservation, reduced motion, and honest Web Store/App Store readiness. Store publication, paid external services and public activation of unvalidated statistical routes require independent authorization/evidence.
