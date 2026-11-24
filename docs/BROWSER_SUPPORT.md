# Browser and site compatibility

The Chromium WXT target is shared by desktop browsers that implement the required Manifest V3 extension APIs. Safari has its own WXT target and Apple containing app. Distribution channels, host-grant UX, available extension APIs and device capabilities can differ. Engine family alone does not establish that a particular browser supports installing extensions.

| Browser | Target and installation | Runtime verification |
| --- | --- | --- |
| Chromium desktop | Load the unpacked chrome-mv3 directory in Developer mode. | Chromium 151.0.7922.34 and Google Chrome for Testing 158.0.8127.88 passed the label and offline-inference workflow. |
| Edge and Brave desktop | Use the same Chromium resources and local grant flow. | Edge 158.0.4370.33 and Brave 1.100.59 passed the full fixture workflow. |
| Opera desktop | Use the Chromium build. | Opera 140.0.6074.36 (Chromium 157.0.8103.79) passed the full fixture workflow. |
| Safari on macOS | Convert safari-mv3 into a Safari Web Extension containing app on a Mac. Enable the extension and website access in Safari. | The unsigned macOS host compiled with Xcode. Native desktop Safari 27.2 passed six real credential fixtures. The installed extension grant, badge and revocation walkthrough remains. |
| Safari on iOS and iPadOS | Use the iOS containing app, then activate the extension in Safari settings on the device. | The unsigned iOS simulator host compiled. Native device, performance and signing acceptance remain. |
| Other mobile Chromium-family browsers | Browser and platform must expose a compatible extension installation mechanism. | No blanket mobile support claim. |

Vivaldi is outside this project's supported browser scope. Additional desktop brands require separate native verification before they can be listed as supported.

## Website coverage

The scanner works from discoverable DOM media, browser-readable pixels and available originals. A page can host an enabled site while its media comes from a different origin, lacks a credential, is a protected stream, uses a non-readable canvas or carries a generated still as a video poster. These cases can legitimately remain unlabeled. Account pages and private feeds are outside the target.

Each document keeps up to 200 analysis entries. Native viewport observation admits newly visible media and reclaims slots from offscreen entries as the user scrolls. Pages with more than 200 simultaneously visible media elements can exceed this budget. A short eligible video can carry its own signed original. A poster image never establishes the provenance of an entire video.

X, Instagram, Facebook, Reddit, TikTok, YouTube, LinkedIn and news sites have no verified site-specific acceptance result in this preview. Record a dated test for each site's accessible public page with asset type, representation, source changes and actual behavior before listing it as supported. Never use a private feed as a test fixture.
