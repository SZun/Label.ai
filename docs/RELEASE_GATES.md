# Release gates

| Gate | Evidence needed for release |
| --- | --- |
| Packaged Chromium workflow | Install the exact release artifact and grant an origin, verify a known positive and multiple abstentions, swap the source, revoke access, switch the test profile offline, observe outgoing requests, restart the worker, and verify keyboard/pointer/playback behavior. Record brand, OS, build and artifact digest. |
| Safari macOS and iOS/iPadOS | Package with Xcode, sign as appropriate for the device, enable site access in native Safari, repeat badge/privacy/revocation tests, inspect memory on phone and verify suspension/restore. A successful WXT build or simulator compile alone cannot satisfy this gate. |
| Image forensics | Use a frozen, group-disjoint calibration and evaluation corpus including artist-made images, CGI, generated media, edits, composites and unseen generators. Require 99% projected precision, FPR no greater than 0.1%, and at least 50% recall per the evaluation protocol. |
| Video forensics | Freeze a trained temporal policy. Evaluate independent full clips including real camera footage, hybrid clips, short generated inserts, compression, looping streams and unseen generators. Count one trial per clip. Apply the release thresholds to videos independently. |
| Provenance and trust updates | Verify fixture behavior with the packaged WASM; review current signer and TSA roots, rights and expiration. Refresh the maintained trust snapshot before its deadline. Ship an audited package update and retest altered, untrusted, expired and mixed-scope cases. |
| Performance and websites | Measure memory, p50/p95 latency, UI responsiveness, feed discovery and source replacement on supported minimum hardware. Test the named public sites with real permissions and re-check when page formats change. |
| Store and signing review | Complete user-facing privacy disclosure, permission justification, asset/dependency license review, browser store policy and signing checks. Publisher credentials and authority to submit are external. |

## Rollback

Pause through the options page or withdraw a site grant for immediate local control. To withdraw a model or policy in a distributed build, prepare a new extension version with that route disabled, preserve its fixture regressions, clear obsolete in-memory decisions and repeat package acceptance. Trust snapshots have a finite life. Do not re-enable expired roots by extending a date without review. Development ZIPs and unsigned Xcode projects do not confer store approval.
