# Native Safari acceptance

Safari support has three separately verifiable stages: native WebDriver
credential verification and exact-package installation, installed extension
behavior, and physical-device distribution/performance. A successful conversion
or Xcode compilation satisfies the build stage only.

The PR workflow requires native desktop Safari to verify the six bundled
credential fixtures and acknowledge installation of the exact Safari package.
It also compiles both Apple containing apps. The separate
`safari-interactive-acceptance` jobs are available through GitHub Actions’
manual **Run workflow** action with **safari_interactive** checked. They run
the strict desktop installed-overlay test using the exact shipping package
and the credential verifier in native Simulator Safari. The installed-overlay
test first opens the publisher immediately after installation and asserts the
signed badge before opening the extension's options. It then checks local ONNX
execution and global pause, resume and clear behavior. Safari's native website
access and focus must be available. Native options-origin discovery remains a
possible hosted-runner blocker; no host permission or scanner is injected to
bypass it. Real iPhone/iPad extension enablement remains a device acceptance step.

## Recorded hosted-runner result

The desktop jobs on November 24, 2026, acknowledged installation of the
unmodified package, returned the six expected credential decisions and compiled
both containing apps. The previous per-site-permission design was also tested
using a disposable copy. Safari loaded its genuine options page, which reported
`incognito: false`, but the automated consent handler did not report success
within its 12-second deadline, and the options document lacked focus. The
overlay workflow therefore did not reach its badge checks. Earlier iOS
Simulator jobs timed out at SafariDriver's remote session connection before
any fixture ran. These results predate the automatic-scanning design. Native
installed-overlay and device acceptance for the new design still need to be
recorded.

See [run 45501017688](https://github.com/SZun/Label.ai/actions/runs/45501017688)
and [run 45500162290](https://github.com/SZun/Label.ai/actions/runs/45500162290).

## Manual macOS walkthrough

On a Mac with current Safari, Node.js 24, pnpm and Python 3.12, run:

```sh
make bootstrap
make verify
make package
python3 tools/demo_page.py
```

Use a fresh regular Safari profile. In Safari's Advanced settings, enable
features for web developers, then use **Add Temporary Extension…** in the
Developer settings to select `apps/extension/.output/safari-mv3` (the exact
unpacked shipping resources). Authenticate the standard unsigned-extension
prompt and enable Label.ai in the Extensions settings. Allow its required
website access through Safari's standard extension controls. The extension has
no website selector. Safari may still restrict individual sites according to
its own settings.

1. Keep the demo publisher running. Visit `http://127.0.0.1:8765` in a regular
   Safari window. With native website access denied, the extension must not
   label either sample.
2. Grant the extension website access through Safari's own extension controls.
   Open or reload the publisher. A newly installed extension automatically
   scans eligible visible media without selecting a site through Label.ai.
3. Keep the publisher tab visible and focused. Wait up to 45 seconds.
   Expect a single **AI Slop Detected 🤮** badge on the Firefly cat and no
   badge on the conventional gradient. The badge should be noninteractive,
   animate once, and leave scrolling and image interaction usable.
4. If Web Inspector is available, use the publisher's Console to change the
   visible image to the already displayed conventional control:
   ```js
   document.querySelector('#asset').src = document.querySelector('#control').src
   ```
   The label must disappear. Next show the publisher's digest-addressed
   original:
   ```js
   document.querySelector('#asset').src = globalThis.addressed
   ```
   The badge must return after verification. Return to the signed embedded
   original and test removal from the DOM:
   ```js
   document.querySelector('#asset').src = globalThis.signedSource
   // Wait for the badge before running the next line.
   document.querySelector('#asset').remove()
   ```
   There must be no stale label. Reload to restore the fixture.
5. Enable reduced motion through system Accessibility settings. Repeat the
   positive test and check that the label remains static.
6. While the publisher's embedded samples are loaded, use developer tools'
   offline mode for the fixture tab where available. Switch the image between
   the embedded signed example and the conventional control again. The
   signed result should work locally. Restore normal tab connectivity after
   the test. If the browser lacks a tab-level offline control, record that
   this offline check was not exercised. In Web Inspector, review network
   activity from the publisher and extension contexts where available.
   The only permitted media GET is the bounded same-origin publisher
   acquisition. No analysis upload or external model/analytics request is
   expected.
7. Open a private browsing window. Visit the fixture. No badge should appear.
8. In the regular profile return to Label.ai's options. Confirm **Automatic
   scanning is on.** Choose **Pause scanning**, return to the publisher and
   confirm label removal. Reload and confirm neither sample is labeled. Choose
   **Resume scanning** and return to the publisher; confirm the signed badge
   returns when the page loads. Choose **Clear local data** and verify scanning
   remains paused. Browser website-access permission remains managed by Safari.
9. Resume scanning, then revoke the publisher's website access in Safari's
   own extension settings. Reload and confirm neither sample is labeled.

Record the exact package digest (`shasum -a 256 artifacts/packages/label-ai-safari.zip`),
Safari/OS version, device model, each observed result, and any failing step.
The known signed positive fixture is not evidence of accuracy on unsigned
social-media content.

## iPhone and iPad

The Safari ZIP is a WebExtension resources archive. Use Xcode to create and
run the containing app for iOS and iPadOS:

```sh
make safari-xcode
open artifacts/safari-xcode
```

Open the generated `.xcodeproj`, choose the iOS application scheme (rather
than the extension scheme), select an iPhone/iPad Simulator or connected
development device, and run the app once. Safari extension testing on a
physical device requires an appropriate Apple developer signing configuration.
Use the Safari Extensions settings to enable Label.ai and grant its native
website access. Open a normal tab; scanning begins automatically where Safari
permits the extension.

For Simulator, repeat the walkthrough with the loopback fixture publisher on
the Mac. For physical hardware, the Mac's loopback address is not the device's
loopback address. Serve the same public test fixture on an authorized
development HTTPS origin the device can access with a trusted certificate.
Allow website access through Safari's controls if necessary. Copy the sample
page and assets into a static test fixture directory while the demo server runs:

```sh
mkdir -p artifacts/safari-device-fixture/assets
curl --fail --silent --show-error http://127.0.0.1:8765/ > artifacts/safari-device-fixture/index.html
fixture=tests/fixtures/provenance/firefly-generated.jpg
digest=$(shasum -a 256 "$fixture" | cut -d ' ' -f 1)
cp "$fixture" "artifacts/safari-device-fixture/assets/$digest.jpg"
video=tests/fixtures/provenance/sora.mp4
digest=$(shasum -a 256 "$video" | cut -d ' ' -f 1)
cp "$video" "artifacts/safari-device-fixture/assets/$digest.mp4"
```

Serve that directory as the origin's document root, with the HTML, JPEG and MP4
content types. The assets here are public development fixtures, and the
extension still makes decisions on the device. Do not use private user images
as acceptance fixtures. Repeat the regular browsing, pause, revoke,
private-context and signed-positive controls; test portrait/landscape,
zoom, tab switching, background/foreground restoration, and scrolling on
each physical target. Record device-specific timing and memory observations
through Xcode or Safari Web Inspector.

See Apple's official [running Safari web extensions guide](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
and [WebDriver on iOS/iPadOS](https://developer.apple.com/documentation/safari-developer-tools/ios-enabling-webdriver).
