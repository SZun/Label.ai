# Running and interpreting the holdout evaluation

Use rights-cleared original media collected independently of browsing. Split by source group before tuning. Freeze the preprocessing, detector, policy and model digests before running a locked evaluation. Keep the manifest and predictions separate. A trusted origin label is required. One source clip counts as one observation regardless of how many frames were decoded.

Run `python tools/evaluation.py assets.jsonl predictions.jsonl --prevalence 0.01 --require-pass`. Input JSONL examples (digest shortened for readability):

    {"sha256":"<64 lowercase hex chars>","group":"clip-17","kind":"video","origin":"generated","license":"CC0-1.0","source":"documented generator and version","slice":"recompressed","split":"release"}
    {"sha256":"<same digest>","policy":"<immutable release candidate>","route":"<detector and runtime versions>","decision":"abstain"}

The manifest can include train/validation/calibration/test rows for cross-split leakage checks. The release partition must contain one predetermined sample per independent source group. Use an additional transform study or a grouped bootstrap for correlated samples, rather than treating image variants or frames as independent. Accepted origins are genuine, generated, and mixed (expected to remain unlabeled). Decisions are label, clear, abstain, unsupported and failed. Every release asset must have exactly one prediction.

Each run scores one frozen route or combined policy. The tool reports confusion counts, coverage, abstention and failures, independent image/video results and slice counts. Its threshold check uses an exact one-sided FPR bound and a conservative joint bound on prevalence-adjusted precision. Missing classes and an empty positive prediction set cannot pass. It does not establish license validity, source independence, distribution representativeness or absence of contamination in pretrained models; those require evidence in the report. Require the release gates as well as the numeric result.

## Developer smoke inputs

`python tools/prepare_smoke_media.py` reconstructs eight SHA-verified example inputs under `artifacts/smoke-media`: the first four image members of a pinned [DiffusionDB archive](https://huggingface.co/datasets/poloclub/diffusiondb) (Stable Diffusion, CC0), plus camera, coffee, Chelsea and astronaut from [scikit-image v0.25.2](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/_fetchers.py). The last four are credited to Lav Varshney, Rachel Michetti, Stefan van der Walt and NASA respectively; see the upstream docstrings for individual rights. This small convenience set verifies execution and data handling. It is neither a tuning set nor a release holdout.

`python tools/prepare_video_smoke.py` downloads the first designated text-to-video clip from a pinned [Kling CC0 dataset](https://huggingface.co/datasets/nyuuzyou/klingai) plus the [MDN flower footage](https://github.com/mdn/shared-assets/tree/f160bcf2db52b60820a7728aa9b3fa88568cfc38/videos) in MP4 and WebM. These are development inputs. The two flower encodings represent one source and cannot count as separate independent negatives.

## Browsing image cutoff comparison

Run `python -m tools.evaluate_browsing_sensitivity` from a provisioned checkout. The script compares raw-score cutoffs of 0.65 and 0.10 on the same images with the bundled WASM detector. It freezes 114 original source IDs disjoint from the earlier development sample, plus 38 Instagram variants from those groups. Each original counts once. Unsupported inputs stay in the denominator. The report records the selection hash, asset hashes, per-image scores and Wilson intervals. It measures the model on benchmark media. Publisher permissions and browser discovery also affect how many images get badges on a website. [Recorded comparison](../ml/reports/frontier-browsing-sensitivity.json)

The separate 224×126 thumbnail check center-cropped the 38 Instagram images. Version 0.1.3 rejected inputs this shape. At the new image cutoff, 3/19 generated crops and 0/19 genuine crops triggered the model. This lower result matters for browsing feeds that serve only small previews.
