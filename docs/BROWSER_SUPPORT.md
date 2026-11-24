# Browser and site compatibility

The Chromium WXT target is shared by desktop browsers that implement the required Manifest V3 extension APIs. Safari has its own WXT target and Apple containing app. Distribution channels, host-grant UX, available extension APIs and device capabilities can differ. Engine family alone does not establish that a particular browser supports installing extensions.

| Browser | Target and installation | Runtime verification |
| --- | --- | --- |
| Chrome / Chromium desktop | Load the unpacked chrome-mv3 directory in Developer mode. | See the dated verification record. |
| Edge, Brave, Vivaldi, Opera and other Chromium desktops | Use the same Chromium resources where unpacked MV3 extensions are supported. | Each named brand requires its own test. Presence of an executable is insufficient. |
| Safari on macOS | Convert safari-mv3 into a Safari Web Extension containing app on a Mac. Enable the extension and website access in Safari. | Native installation, badge, motion and revocation acceptance required. |
| Safari on iOS and iPadOS | Use the iOS containing app, then activate the extension in Safari settings on the device. | Native device or simulator plus real-device performance and signing acceptance required. |
| Other mobile Chromium-family browsers | Browser and platform must expose a compatible extension installation mechanism. | No blanket mobile support claim. |

## Website coverage

The scanner works from discoverable DOM media, browser-readable pixels and available originals. A page can host an enabled site while its media comes from a different origin, lacks a credential, is a protected stream, uses a non-readable canvas or carries a generated still as a video poster. These cases can legitimately remain unlabeled. Account pages and private feeds are outside the target.

X, Instagram, Facebook, Reddit, TikTok, YouTube, LinkedIn and news sites have no verified site-specific acceptance result in this preview. Record a dated test for each site's accessible public page with asset type, representation, source changes and actual behavior before listing it as supported. Never use a private feed as a test fixture.
