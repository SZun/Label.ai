# Local inference, model provenance, and validation

Label.ai performs media analysis on the user's device. The extension uses the real, pinned Detectra ONNX image model through ONNX Runtime Web/WASM. The model is never queried through a hosted API. This directory contains developer provisioning, local calibration tools, license notices, and actual inference reports.

**The image and video statistical label routes are disabled in the shipped policy.** Real scores are computed internally, but a strong model score is insufficient evidence to put an accusation on somebody's media. No held-out dataset currently establishes this application's required precision/FPR bounds, and no fitted temporal calibration artifact is bundled. Verified C2PA provenance is a separate route owned by `packages/provenance`; canvas pixels cannot establish original-file provenance.

## What is implemented

| Component | Behavior |
| --- | --- |
| Image inference | Actual ViT-S/16 forward pass on pixels, input-dependent scalar logit, optional fitted Platt mapping |
| Preprocessing | RGBA composited on white; preserve aspect ratio; shortest edge 440; bilinear resize; center crop 384; ImageNet normalization; planar float32 |
| Temporal analysis | Up to 12 actual video frame inferences; frame-score distribution; 32×32 luma changes and consecutive second differences; scene discontinuities; per-second logit changes |
| Coverage | Computes bounded temporal support from timestamps. Caller-provided coverage is ignored. Distant first/last frames cannot imply full coverage |
| Video scoring | Supports a supervised logistic model over image and temporal features; requires a separately fitted artifact. The uncalibrated lower-quartile frame score is only a diagnostic |
| Policy | Build-time, reviewed route evidence must match the pinned model, preprocessing, fitted calibration version, threshold, and quality bounds |
| Failure behavior | Missing assets, checksum mismatch, invalid input, cancellation, low temporal coverage, contradictory frame evidence, or unvalidated route yields no label |
| Privacy | Runtime fetches only two pinned extension resources: ONNX weights and WASM. No media, source URL, hash, embedding, logits, or diagnostic output is uploaded |

The preprocessing version is `rgb-white-bilinear440-center384-imagenet-v1`. This explicit implementation must be used for calibration and evaluation. The author's browser pipeline uses a canvas resize, whose interpolation can differ from this deterministic bilinear transform. Author-reported results therefore cannot be treated as validation of this application.

## Model and runtime provenance

The exact checkpoint and sources are in [model-manifest.json](model-manifest.json).

- Model: `detectra-v3-vits16-384`, published as `TensorFold/detectra-v1`, revision `2bbc31161daa46932e05ee6f96e7016ee817bbde`.
- Weights: 43,684,258 bytes, SHA256 `1414b9aafaa01a644ed706224973f09b53a1388282104409862df9893b1b962b`.
- ONNX: fp16 internal weights with fp32 input `pixel_values` `[1,3,384,384]` and output `logit` `[1,1]`.
- Runtime: `onnxruntime-web@1.31.1`, single-thread WASM, 14,848,852-byte WASM asset pinned to SHA256 `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d`.
- Model license: MIT as declared in the [pinned model card](https://huggingface.co/TensorFold/detectra-v1/blob/2bbc31161daa46932e05ee6f96e7016ee817bbde/README.md). Author source/license: [Detectra](https://github.com/ashhart/Detectra). Base checkpoint: [OwensLab/commfor-model-384](https://huggingface.co/OwensLab/commfor-model-384).
- Runtime license: [Microsoft's MIT license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). Full upstream third-party notices are retained in `licenses/`. The NPM package omits these text files; they were obtained from the SHA-verified official 1.31.1 Python wheel. `licenses/onnxruntime-source.json` records the exact source/checksum. Its notice inventory includes components unused by the browser build.

The model card's dataset and accuracy statements are the author's claims. They do not prove absence of training overlap with public smoke images or grant rights to redistribute the original training datasets. No dataset is bundled in the extension.

## Provisioning and packaging

Run from the repository root after `pnpm install`:

```sh
node ml/provision-model.mjs
node ml/provision-model.mjs apps/extension/public/models
```

The first command creates an ignored developer cache in `ml/weights/`. The second copies verified resources into the extension's public assets. The pinned download is a **developer build operation**, never extension runtime code. Already-provisioned assets are rechecked; corrupt files fail the command. The script verifies the installed WASM version and hash and copies MIT licenses, third-party notices, the model manifest, and asset checksums.

Normal operation is offline after the extension has been installed with these bundled files. There is no first-use model download, hosted classifier, API key, remote configuration, or cloud fallback. Do not replace the extension URL with a CDN. Runtime refuses HTTP(S), file, data, and cross-extension asset URLs.

### Browser runtime details

`createLocalDetector({ assetBaseUrl })` is exported from `@label-ai/detector`. The pinned runtime's `/wasm` ESM export statically embeds its WASM JavaScript glue. Label.ai loads the verified WASM binary into `env.wasm.wasmBinary`; it does not override `wasmPaths` with a JavaScript URL. This avoids the dynamic import prohibition in Chromium Manifest V3 service workers. `numThreads = 1` and `proxy = false` avoid SharedArrayBuffer and worker-spawning requirements.

Use an extension-owned background context with `wasm-unsafe-eval` CSP. The implementation also works in a dedicated extension worker. WebGPU is not enabled: the verified portable path is WASM. Safari compatibility of the portable engine is separate from installation/signing of a native Safari extension, which must be checked on macOS.

The public methods are:

```ts
const detector = await createLocalDetector({ assetBaseUrl });
await detector.analyzeRgba({ rgba, width, height, signal });
await detector.analyzeVideoFrames({ frames, durationMs, signal });
await detector.dispose();
```

Each video frame adds `timestampMs` to the same RGBA shape. Width and height must each be 128–1024, integer, with exactly `width * height * 4` bytes. The extension captures video at a smaller limit to control transfer and memory cost. Neither input includes a source URL or filename. Inference is serialized and the engine caps its pending jobs at two; the extension also applies global queue and lifecycle budgets.

An optional `analyzeImage({bytes,mime,signal})` accepts **bounded, non-animated PNG only**, intended for already-captured pixels. It checks container dimensions and animation chunks before native decoding. In contexts without `createImageBitmap`/`OffscreenCanvas`, it returns unsupported; use `analyzeRgba` in a service worker. Browser-supported JPEG, WebP, and other sources are decoded/captured by the extension and use RGBA. This image API does not establish source provenance.

Cancellation is checked before and after each native call. A synchronous WASM call cannot be interrupted mid-instruction; its result is discarded if canceled. Video analysis yields a browser task between frames so cancellation messages and deadline timers can stop further calls. Disposal waits for the current serialized queue and releases the session exactly once. No pixel/logit result is persisted by this package.

## Temporal policy and limits

Dense support uses adjacent gaps of at most `min(1,500ms, duration/6)`. A sample contributes at most half that interval on either side, and isolated samples contribute no temporal support. At least eight frames, four consecutive triplets, and 80% supported duration are needed before inference can establish eligible video evidence. Twelve frames usually cover a short clip; longer videos often abstain rather than infer an unseen timeline.

The feature extractor computes first-order luma changes and time-adjusted second differences, frame logit variation, lower-quartile and mean logits, and scene discontinuities. It rejects an unchanged poster/duplicated frame stream, mixed positive/negative frame evidence, and excessive discontinuities. It does not inspect audio or certify unsampled portions as authentic. These conservative checks also reduce recall on legitimate generated clips; the real Kling smoke result demonstrates that limitation.

The learned video combiner must use at least one temporal feature. A configuration that simply takes a maximum frame score cannot pass the runtime's temporal calibration contract. No temporal coefficients are invented, borrowed from an unrelated task, or fitted to the smoke fixtures.

## Calibration and release evidence

Install the offline developer dependencies from `requirements.txt`. They are not shipped in the extension.

```sh
python -m pip install -r ml/requirements.txt
python ml/calibrate.py --modality image \
  --input local-data/image-calibration.jsonl \
  --holdout-manifest local-data/untouched-holdout.jsonl \
  --output local-data/image-calibration-artifact.json
```

For video use `--modality video` and include the exact `temporal` features returned by this runtime. Each calibration JSONL row must include `sha256`, `group`, `split: "calibration"`, matching `kind`, independently established `origin` (`generated`, `genuine`, or `camera`), and documented `license` or `rights`. Images supply `logit`; videos supply the seven named temporal features. The holdout manifest supplies `sha256`, `group`, and `split: "test"` or `"validation"`.

The fitter rejects duplicate assets, content/group overlap with the holdout, invalid/nonfinite features, and insufficient independent groups per class. Group weights prevent multiple variants of the same source from dominating the fit. It standardizes features, fits regularized logistic regression, and converts coefficients back to runtime units. At least 20 groups per class is a fitting floor, **not** a claim of adequate release evidence.

Every generated artifact starts `release_approved: false`. Freeze that artifact, run the separate repository evaluator on a genuinely untouched holdout, inspect error slices and generator/site coverage, and review promotion as a build change. The runtime's route gate requires projected precision lower bound ≥99%, FPR upper bound ≤0.1%, and recall ≥50%, with matching model/preprocessing/calibration/threshold. It requires evidence hashes and rejects use of the same calibration and holdout manifest. A fabricated JSON report cannot be made trustworthy by software consistency checks; the evidence review remains necessary.

Do not enable the route because its smoke examples look convincing, and do not reuse test examples to tune the threshold. The user-facing label contains no probability or diagnostic score.

## Tests and actual media evidence

Fast verification from the repository root:

```sh
pnpm --filter @label-ai/detector test
pnpm --filter @label-ai/detector typecheck
python -m unittest discover -s ml -p 'test_*.py' -v
```

After preparing the repository's licensed local smoke media:

```sh
pnpm --filter @label-ai/detector test:inference
node --experimental-strip-types packages/detector/tests/real-inference.ts \
  artifacts/video-smoke/manifest.jsonl ml/reports/video-smoke-wasm.json
```

The integration script verifies model and fixture hashes, decodes actual supplied media, executes the real ONNX network using WASM, exercises the real engine and policy, and records scores, timing, model/runtime/preprocessing versions, and route status. It does not import a mock classifier. `ffprobe`/`ffmpeg` are used only for local offline video fixture preparation; normal browser decoding is the extension's responsibility.

Recorded development results:

| Inputs | Actual internal output | Observed CPU elapsed time | Shipped visible behavior |
| --- | --- | --- | --- |
| Four early Stable Diffusion images | Raw scores 0.99205–0.999999 | 1.39–1.52 s/image | No label; unvalidated route |
| Four genuine photos | Raw scores 0.000517–0.06872 | 1.40–1.50 s/image | No label |
| Kling generated MP4 | Lower-quartile frame diagnostic 0.65555; mixed frame evidence; 100% sampled support; 10 consecutive triplets | 17.16 s/12 frames | No label |
| One camera flower clip, WebM and MP4 | Lower-quartile diagnostics 0.00180 and 0.00251; 100% support; 10 consecutive triplets | 17.10–17.43 s/12 frames | No label |

These measurements are Linux x64/Node24/WASM developer smoke evidence. They are not Chrome/Safari latency guarantees and do not establish general detection accuracy. The two flower encodings are one underlying camera clip, not two independent negative examples. Reports are in [reports/image-smoke-wasm.json](reports/image-smoke-wasm.json) and [reports/video-smoke-wasm.json](reports/video-smoke-wasm.json). Browser integration results are maintained by the extension's acceptance suite.

Tests were written and run against missing behavior before implementation. They cover normalization/aspect/alpha, input limits, PNG decode boundaries, canceled/stale native results, serialized session lifetime, cancellation between video frames, asset origin/size checks, temporal coverage, isolated posters, short generated intros, second differences, policy consistency, and calibration split leakage. Runtime mocks are confined to contract/unit tests; the separate media test uses real weights and computation.
