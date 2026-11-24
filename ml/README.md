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

For video use `--modality video` and include the exact `temporal` features returned by this runtime. Each calibration JSONL row must include `sha256`, `group`, `split: "calibration"`, matching `kind`, independently established `origin` (`generated`, `genuine`, or `camera`), and documented `license` or `rights`. Images supply `logit`; videos supply the seven named temporal features. The holdout manifest supplies `sha256`, `group`, and `split: "test"`, `"validation"` or `"release"`.

The fitter rejects duplicate assets, content/group overlap with the holdout, invalid/nonfinite features, and insufficient independent groups per class. Group weights prevent multiple variants of the same source from dominating the fit. It standardizes features, fits regularized logistic regression, and converts coefficients back to runtime units. At least 20 groups per class is a fitting floor, **not** a claim of adequate release evidence.

Every generated artifact starts `release_approved: false`. Freeze that artifact, run the separate repository evaluator on a genuinely untouched holdout, inspect error slices and generator/site coverage, and review promotion as a build change. The runtime's route gate requires projected precision lower bound ≥99%, FPR upper bound ≤0.1%, and recall ≥50%, with matching model/preprocessing/calibration/threshold. It requires evidence hashes and rejects use of the same calibration and holdout manifest. A fabricated JSON report cannot be made trustworthy by software consistency checks; the evidence review remains necessary.

Do not enable the route because its smoke examples look convincing, and do not reuse test examples to tune the threshold. The user-facing label contains no probability or diagnostic score.

### Reproducible local corpus evaluation

The developer-only runner executes the same model/session, WASM bytes, spatial
preprocessing, and temporal engine as the extension. Supply local, licensed
assets and a JSONL inventory with one row per file. Each row requires
`file` (relative to the manifest's directory), `sha256`, `kind`, `origin`,
`source`, `license`, `group`, `split` and `slice`. Image and video release
inventories are separate. Maintain the same source group for all renditions,
edits and derivatives. The runner checks input file identities and both pinned
runtime artifacts before analysis. It never enables the production route.

For a fresh independent image corpus, prepare separate locked calibration and
release inventories, then run:

```sh
node --experimental-strip-types packages/detector/tests/run-corpus.ts \
  --manifest local-data/image-calibration-manifest.jsonl --split calibration \
  --output local-data/image-calibration-outputs.jsonl
python ml/calibrate.py --modality image \
  --input local-data/image-calibration-outputs.jsonl \
  --holdout-manifest local-data/image-release-manifest.jsonl \
  --threshold 0.99 --output local-data/image-candidate.json
node --experimental-strip-types packages/detector/tests/run-corpus.ts \
  --manifest local-data/image-release-manifest.jsonl --split release \
  --candidate local-data/image-candidate.json \
  --output local-data/image-release-predictions.jsonl
python tools/evaluation.py local-data/image-release-manifest.jsonl \
  local-data/image-release-predictions.jsonl --modality image --require-pass
```

The candidate binds threshold, fitted parameters, exact holdout bytes, model
and preprocessing. The output records the candidate's SHA-256 in its policy
identifier; runtime failure and unsupported media count as misses in recall.
The evaluator reports modality/slice counts, exact one-sided confidence bounds,
and prevalence sensitivity. Repeat for video using a separate candidate.
Keep all calibration rows (including failed/ineligible ones) in the source
inventory so split checks remain complete; only usable inference features enter
the fit. The fitter reports excluded counts. Do not change the candidate after
viewing a release report or reuse that holdout to select a route.

This evaluation is offline developer evidence. Pillow/ffmpeg decoding and
video timestamps approximate browser acquisition; native browser color
management, playback offsets, cross-origin access and actual visibility require
separate installed-extension evaluation for product-level recall.

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


## November 2026 frontier-generator development comparison

On November 24, 2026, the pinned local model executed on 82 files from the
October 2026 [WasItAIGenerated Frontier Image & Video Benchmark](https://huggingface.co/datasets/wasitaigeneratedcom/frontier-image-video-bench-2026-10)
public revision `e6a8b83d15fab1da958848368fcd07e943afafd0`. The pinned metadata
and selected asset digests, generator, source, author, license, elapsed local
execution time and decision are recorded in
[reports/frontier-dev-2026-10.json](reports/frontier-dev-2026-10.json).
The images are attribution-licensed (generated CC BY 4.0, genuine per-file free
licenses); the raw media is not redistributed here. The report represents
44 source groups: 38 image groups (each has a paired Instagram rendition)
and six original clips. No benchmark asset was used to fit or tune a policy.

| Local uncalibrated diagnostic | Generated scores ≥ 0.99 | Generated scores ≥ 0.5 | Genuine scores ≥ 0.5 |
| --- | ---: | ---: | ---: |
| Images from 19 current generators | 0/19 | 4/19 | 0/19 |
| Instagram renditions of those images | 0/19 | 2/19 | 0/19 |
| Videos from three current generators | 0/3 | 0/3 | 1/3 |

All 82 analyses completed. The extension's disabled statistical route yielded
no labels. The video diagnostic is a lower-quartile frame score; only one of
three generated clips passed the temporal-eligibility guard. The genuine clip
with a raw score of 0.5454 failed the mixed-frame guard. These observations
expose a serious generalization gap in the current model: the early diffusion
smoke results did not predict behavior on current generators. These are
development results, not release confidence bounds. The subset has unknown
training overlap, lacks dedicated art/CGI/hybrid slices, and is far too small
for the project's release FPR and precision requirements.

Reproduce the sample locally without uploading any media:

```sh
python tools/prepare_frontier_dev.py
node --experimental-strip-types packages/detector/tests/run-corpus.ts \
  --manifest artifacts/frontier-dev/image-manifest.jsonl \
  --output artifacts/frontier-dev/image-rerun.jsonl
node --experimental-strip-types packages/detector/tests/run-corpus.ts \
  --manifest artifacts/frontier-dev/video-manifest.jsonl \
  --output artifacts/frontier-dev/video-rerun.jsonl
```

### Candidate research for the next model comparison

Two compact ONNX image candidates have public model cards. One was measured
in the bounded development comparison below; neither has been cleared for
Label.ai distribution.

- [Slop Detect ViT-S int8](https://huggingface.co/Loke-60000/slop-detect-vit-s-onnx):
  MIT-declared checkpoint; the publisher describes web-degraded training and
  reports 85.3% balanced accuracy on 21 unseen generators. Its CLIP
  normalization differs from the current model and training-data rights need
  review.
- [GPTTrace CF ViT-S fine-tune](https://huggingface.co/nakas/gpttrace-cf-vit-ft-v1):
  24 MB ONNX, CC BY-SA 4.0 weights, trained on newer generators; its
  publisher reports especially weak FLUX dev and GPT Image results on its
  in-house test. Adopting it requires preprocessing parity and review of
  share-alike rights.

For video, [AEGIS](https://huggingface.co/MusapYildiz/aegis-video-detector)
has MIT-declared PyTorch checkpoints targeting whole-video generation, not
an audited portable ONNX export. Its authors' validation FPR of 2.18% also
exceeds Label.ai's 0.1% maximum. It would require training-data rights review,
an export, device profiling and independent full-clip evaluation.

At 1% target prevalence, even a detector with a joint lower recall bound of
50% would require roughly 72,300 source-independent negatives with zero false
positives for the current projected 99% precision lower-bound criterion. That
calculation is a feasibility bound; calibrated recall and actual observed errors
will determine the necessary size. Neither this development corpus nor the
publicly available frontier split satisfies that acceptance condition.


### One bounded comparison with the newer Loke ONNX model

The same 38 original image files were then run once with the publisher's
23,046,673-byte int8 ONNX artifact
([revision 3bed6a1e](https://huggingface.co/Loke-60000/slop-detect-vit-s-onnx/tree/3bed6a1e72ae7c3f8a783ecbee8d3d71a64a12e4)).
The runtime and model SHA-256 were verified before inference, and channels
were normalized using the published `model.json` CLIP constants. All 38
inferences completed with a median inference time of 843 ms on the
development CPU. Pairwise ranking AUROC was 0.817 (Loke) versus 0.778
(Detectra). Counts at preexisting diagnostic thresholds follow.

| Raw threshold | Detectra generated / genuine flagged | Loke generated / genuine flagged |
| --- | --- | --- |
| 0.65 (Loke author threshold) | 4/19 / 0/19 | 6/19 / 1/19 |
| 0.99 | 0/19 / 0/19 | 2/19 / 0/19 |

The replacement candidate had modestly better ranking on this sample. Its
high-score recall was still low and its author threshold flagged a real
image. No model was promoted, no threshold was tuned, and the independent
release gate is still outstanding. Candidate per-file raw results and
hashes are in the same frontier report.

To reproduce after preparing the sample, provision the exact candidate
weights below. The developer comparison validates the expected model
size and checksum before use.

```sh
curl --fail --location --max-time 60 \
  https://huggingface.co/Loke-60000/slop-detect-vit-s-onnx/resolve/3bed6a1e72ae7c3f8a783ecbee8d3d71a64a12e4/model.onnx \
  --output artifacts/frontier-dev/loke-candidate.onnx
python ml/prepare-smoke.py artifacts/frontier-dev/originals-manifest.jsonl \
  artifacts/frontier-dev/originals-prepared
node --experimental-strip-types packages/detector/tests/compare-loke.ts \
  artifacts/frontier-dev/loke-candidate.onnx \
  artifacts/frontier-dev/originals-prepared/prepared.json \
  artifacts/frontier-dev/loke-rerun.jsonl
```
