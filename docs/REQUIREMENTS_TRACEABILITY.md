# Requirement traceability

The IDs and short descriptions come from the preserved original proposal. Status applies to the current on-device specification. Implemented describes a delivered capability with named evidence. Partial identifies a delivered part with an open acceptance criterion. Superseded records an owner-approved architecture change. Current verification outcomes are in [PROGRESS.md](PROGRESS.md).

| ID | Original scope | Status | Implementation, verification or remaining work |
| --- | --- | --- | --- |
| GOV-01 | Read AGENTS and specification; plan before Build | Implemented | AGENTS.md, docs/IMPLEMENTATION_PLAN.md and recorded owner instructions. |
| GOV-02 | TDD and best practices | Partial | Focused red/green unit tests, package/type checks. Full release acceptance remains open. |
| GOV-03 | Proactive parallel agents, bounded concurrency | Implemented | Implementation plan assigns separate extension, provenance and detector ownership, with integrated review. |
| GOV-04 | Durable progress and scope control | Implemented | Architecture decision, preserved original, this ledger and release gates. |
| GOV-05 | Complete verification and truthful status | Partial | Progress record and CI report distinguish observed results from open gates. |
| STACK-01 | Chrome MV3/WXT/Svelte 5/TS/SMUI | Partial | WXT Chromium and Safari targets, Svelte components and SMUI, pinned workspace and separate browser acceptance. |
| STACK-02 | FastAPI + GraphQL client/server | Superseded | On-device messages connect the page and background. There is no GraphQL service or client. |
| STACK-03 | PostgreSQL when durable persistence needed | Superseded | Consent lives in browser local storage. No PostgreSQL service is needed. |
| UX-01 | Exact single label with emoji | Partial | SlopLabel.svelte and label.test.ts check the exact text. Browser test checks one badge on the signed fixture. |
| UX-02 | Material-style pill, upper-left overlay | Partial | OverlayRoot.svelte and label.scss implement the anchored pill. Zoom and physical device visual testing remain. |
| UX-03 | Eye-catching one-time animation | Partial | Label CSS, per-source state and reduced-motion browser assertion. Scroll/re-entry needs live acceptance. |
| UX-04 | No other normal browsing UI | Implemented | Noninteractive SMUI Paper is the sole in-page UI. Controls live on the extension options page. |
| UX-05 | Noninterference and accessibility | Partial | Isolated styling, pointer-events, reduced-motion rule and test. Full native accessibility and controls review pending. |
| UX-06 | Fail closed on all nonpositive states | Implemented | Core protocol, detector/provenance policy tests and binding.test.ts exercise the default no-label path. |
| DISC-01 | Generic image discovery | Partial | Content script discovers img/currentSrc and eligible inline backgrounds. Some external backgrounds remain inaccessible. |
| DISC-02 | Generic video discovery | Partial | Video elements and source events, MP4/WebM developer inputs and temporal analyzer. Platform fixtures pending. |
| DISC-03 | Dynamic lifecycle | Partial | Mutation, visibility and resize observers, registered frames and accessible open roots. Feed/site trials pending. |
| DISC-04 | Correct source binding | Partial | Generation, request and source checks plus binding tests and the browser source-change acceptance. |
| DISC-05 | Visibility scheduling and dedup | Partial | Bounded queues, retries and visibility checks are tested. The 240-item browser fixture passed on the five Chromium targets. |
| DISC-06 | Priority websites | Open | docs/BROWSER_SUPPORT.md declares the status of each named public site. |
| DISC-07 | MV3 restart resilience | Partial | Stable registrations on worker startup and per-source bounded retry tests. The browser acceptance opens the same profile across restarts; worker termination during a positive job needs device-specific evidence. |
| ACQ-01 | Consent and public-context policy | Partial | Per-origin opt-in, active tab, password/private-path checks and revocation. Private context cannot always be inferred. |
| ACQ-02 | Safe bounded image/video acquisition | Partial | Bounded rendered pixels, embedded/Blob originals, digest-checked publisher sources and cache-only JPEG/static PNG paths. |
| ACQ-03 | Protected/unavailable media abstention | Partial | Protected or unreadable pixels and unsupported types fail closed. DRM/MSE device coverage remains. |
| ACQ-04 | Representation and coverage fidelity | Partial | Provenance requires original bytes, frame evidence carries timestamps and bounded coverage. Full real-world trials pending. |
| API-01 | Submit/read/batch/cancel GraphQL operations | Superseded | Local scoped messages replace hosted query/submission operations. |
| API-02 | Binary data plane and integrity | Superseded | No upload endpoint, upload capability, remote tickets or data plane. |
| API-03 | Minimal client result | Implemented | LocalDecision returns a scoped boolean, status, expiry and version. The page UI shows only a badge. |
| API-04 | Job lifecycle and recovery | Partial | Local queue, cancellation, generation and expiry. Hosted leases do not apply; worker restart needs acceptance. |
| API-05 | Authentication and authorization | Superseded | Same-extension sender, active tab and exact approved origin replace server authentication. |
| API-06 | GraphQL resource controls | Superseded | Bounded local messages, payload limits and scheduling replace query-cost/rate controls. |
| ML-01 | C2PA verification | Partial | Real offline C2PA WASM checks generated, edited, untrusted, tampered, expired and unsigned originals. Additional scope checks abstain on ambiguous content changes. Video positives need fixtures. |
| ML-02 | Watermark adapter architecture | Open | An offline watermark verifier with an approved license/validated provider has not been integrated; cloud APIs are excluded. |
| ML-03 | Metadata analysis | Partial | Only signature-bound source assertions contribute positive provenance. A standalone metadata classifier is absent. |
| ML-04 | Real image inference | Implemented | Pinned Detectra checkpoint executes through ONNX Runtime WASM; real image report and detector tests. |
| ML-05 | Image model selection and forensics | Partial | Actual frontier comparison across 19 generators exposes generalization gap; local candidate-evaluation runners implemented. Representative disjoint holdout and release model selection remain. |
| ML-06 | Actual video inference | Partial | Actual model executions on a generated video and camera footage in two formats. Production video calibration pending. |
| ML-07 | Temporal analysis and scope | Partial | Timestamp-aware dynamics, temporal differences, scope and coverage tests. No validated full-video threshold. |
| ML-08 | Evidence fusion | Partial | Signed assertion policy and guarded forensic policies. Additional signal providers/conflicts lack release evidence. |
| ML-09 | Calibrated abstention/versioning | Partial | Versioned contracts, abort/expiry and disabled statistical routes. Release fit and verification pending. |
| ML-10 | Licensed reproducible ML assets | Partial | Model and runtime digests, notices and development data sources tracked. Complete release rights review pending. |
| EVAL-01 | Independent evaluation datasets | Partial | Group-disjoint evaluator, frozen candidate workflow and 82 actual development examples across 44 source groups. Independent production corpus acquisition remains. |
| EVAL-02 | Image release quality | Open | Frontier development measurements expose the current model's generalization gap. No locked image precision/FPR release result. |
| EVAL-03 | Video release quality | Open | Development comparisons cover multiple generated and genuine clips, including six modern frontier clips. No locked video release benchmark. |
| EVAL-04 | Robustness and honest limitations | Partial | Negative signature/coverage fixtures and abstention policy; robustness slices need representative examples. |
| EVAL-05 | Non-vacuous release gate | Implemented | tools/evaluation.py and its tests reject leakage, duplicated groups, absent predictions and empty evidence. |
| DATA-01 | Verified exact-content cache | Superseded | No persistent verdict reuse across media. Transient decisions bind to an individual source and expire. |
| DATA-02 | Durable recovery if production enabled | Superseded | The browser performs local ephemeral work. There is no remote durable job store. |
| DATA-03 | Data minimization and deletion | Partial | Settings-only durable data, transient buffers, clearing and cancellation; native crash/restart evidence pending. |
| SEC-01 | Least privilege and consent | Partial | Manifest policy auditing, optional host permissions, local consent and pause/remove. Explicit private-state and frame-ancestry checks, permission failure handling and revocation. Native Safari permission prompt remains pending. |
| SEC-02 | SSRF and network isolation | Partial | No server-side fetcher. Same-origin credential-free eligible source, hash checks and offline credential verification. |
| SEC-03 | Malicious media and resource limits | Partial | Size limits, bounded queues and timeouts. Independent adversarial decoder/resource review remains. |
| SEC-04 | Extension trust boundaries | Partial | Scoped sender, active tab checks, extension-page CSP/package audit and input validators. Browser review continues. |
| SEC-05 | Server security and abuse | Superseded | Server auth, hosted rate limits and credentials are outside this device-only design. |
| SEC-06 | Privacy and third-party processing | Partial | No upload interface, no analytics, offline verifier smoke. Browser network observation and full device coverage tracked separately. |
| SEC-07 | Chrome Web Store readiness | Open | Privacy disclosure and package checks exist; brand-specific store policy review and publication remain. |
| PERF-01 | Bounded client resource use | Partial | Client work is capped; representative 100+ item feed, latency and memory results on devices pending. |
| PERF-02 | Measured backend latency and cost | Partial | CPU WASM developer timings recorded. Device-level p50/p95 and energy measurements pending. |
| PERF-03 | Resilience and backpressure | Partial | Abstention, timeouts and queue backpressure tests; worker suspension/native-device stress coverage pending. |
| OPS-01 | Deployment reproducibility | Partial | Pinned dependencies, model hashes and reproducible build/package commands. See recorded build results. |
| OPS-02 | Operational rollback and monitoring | Partial | Pause/clear and documented route withdrawal/trust refresh; distributed rollback rehearsal remains. |
| OPS-03 | CI and complete quality suite | Partial | CI includes type checks, package audit, five-browser matrix, native desktop Safari exact installation, Apple-host builds and real verifier tests. Strict native overlay and iOS automation are available through explicit dispatch; see current run. |
| OPS-04 | Complete documentation and packaging | Partial | README, model reports, installation, privacy, package resources and compatibility matrix; live-site acceptance pending. |
| OPS-05 | External release gates | Implemented | docs/RELEASE_GATES.md identifies hardware, evaluation, signing, store and user-approval requirements. |
