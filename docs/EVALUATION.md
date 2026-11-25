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

## Video playback and detection

Run `python -m tools.evaluate_browsing_video` to compare both preview rules on pinned generated and genuine source clips. Twelve generated clips from different generators and twelve genuine clips from distinct authors were selected separately from development. The new rule flagged two generated clips compared with one previously, and zero genuine clips at either cutoff. The whole-clip measures for these short inputs do not establish coverage on 60-second clips, streams or private players. [Per-video results](../ml/reports/frontier-browsing-video.json)

The installed Chrome tests use a real Luma Ray 3.2 output attributed to WasItAIGenerated under CC BY 4.0, public camera footage from MDN, and the VideoCrafter2 project's own looping video. A separate 32-second pan of a generated still checks that the badge waits for both playback windows. That pan verifies extension behavior and does not count as an independently generated video sample.

A second test used four-second excerpts from 22 other generated videos and 22 other genuine videos. The previous rule flagged one generated excerpt. The updated rule flagged six and left all 22 genuine excerpts clear. A separately trained temporal classifier found no additional positives on that set and is excluded from the browser package. Sampling only an excerpt cannot establish the origin of its source video. [Training and validation report](../ml/reports/frontier-temporal-fit.json)

## Social video playback in the 0.1.7 preview

Installed Chrome exercised a generated stream joined 70 seconds into playback. It submitted ten frames from a four-second window, displayed a video badge, then removed it and completed a negative scan when the same player switched to camera footage. [Installed stream test](https://github.com/SZun/Label.ai/actions/runs/45527174384/job/138913458066)

The publisher identified its Bluesky example as Sora 2 footage. Chrome played that exact post and sampled it. Three independently decoded four-second windows from its first twelve seconds produced lower-quartile model scores of 0.0074, 0.0071 and 0.0022. All three missed the display threshold. An exploratory higher-resolution center crop also missed all three, and one genuine camera control scored higher than the generated windows. Raw scores are uncalibrated. [Publisher post](https://bsky.app/profile/carnage4life.bsky.social/post/3m23sq2iios2g) · [Browser check](https://github.com/SZun/Label.ai/actions/runs/45527174384/job/138913458060)

The YouTube guest session required sign-in before playback. On TikTok an early positional test mistook a badge above the player for a confirmed video decision. Acceptance now requires a badge explicitly bound to video. [YouTube check](https://github.com/SZun/Label.ai/actions/runs/45527174384/job/138913458074) · [TikTok check](https://github.com/SZun/Label.ai/actions/runs/45527174384/job/138913458053)
