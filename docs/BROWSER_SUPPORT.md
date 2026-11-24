# Browser and site compatibility

The Chromium WXT target is shared by desktop browsers that implement the required Manifest V3 extension APIs. Safari has its own WXT target and Apple containing app. Distribution channels, host-grant UX, available extension APIs and device capabilities can differ. Engine family alone does not establish that a particular browser supports installing extensions.

| Browser | Target and installation | Runtime verification |
| --- | --- | --- |
| Chromium desktop | Load the unpacked chrome-mv3 directory in Developer mode. | Chromium 151.0.7922.34 passed the label and offline-inference workflow. Google Chrome for Testing is a separate test target. |
| Edge and Brave desktop | Use the same Chromium resources and local grant flow. | Edge 158.0.4370.33 and Brave 1.100.59 passed the full fixture workflow. |
| Google Chrome for Testing, Vivaldi, Opera and other Chromium desktops | Use the Chromium build where unpacked MV3 extensions are supported. | See the individual jobs in the current PR. Other brands and mobile installations require separate verification. |
| Safari on macOS | Convert safari-mv3 into a Safari Web Extension containing app on a Mac. Enable the extension and website access in Safari. | The unsigned macOS host compiled with Xcode. Native extension grant, badge and revocation acceptance remain. |
| Safari on iOS and iPadOS | Use the iOS containing app, then activate the extension in Safari settings on the device. | The unsigned iOS simulator host compiled. Native device, performance and signing acceptance remain. |
| Other mobile Chromium-family browsers | Browser and platform must expose a compatible extension installation mechanism. | No blanket mobile support claim. |

## Website coverage

The scanner works from discoverable DOM media, browser-readable pixels and available originals. A page can host an enabled site while its media comes from a different origin, lacks a credential, is a protected stream, uses a non-readable canvas or carries a generated still as a video poster. These cases can legitimately remain unlabeled. Account pages and private feeds are outside the target.

A document tracks up to 200 media elements to bound memory. A long feed that keeps all of its old DOM nodes can fill that registry and leave later items unscanned. A short eligible video can carry its own signed original. A poster image never establishes the provenance of an entire video.

X, Instagram, Facebook, Reddit, TikTok, YouTube, LinkedIn and news sites have no verified site-specific acceptance result in this preview. Record a dated test for each site's accessible public page with asset type, representation, source changes and actual behavior before listing it as supported. Never use a private feed as a test fixture.
