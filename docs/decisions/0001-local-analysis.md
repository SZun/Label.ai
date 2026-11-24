# Use the browser as the detection runtime

The owner requires automatic labels on the current page from installation without individual site selection, no media uploads, and support for Chromium browsers and Safari. Install-time HTTP/HTTPS host access and global pause/resume replace the initial per-site opt-in design. The browser owns discovery, acquisition, inference and display. Development tools may evaluate properly licensed reference datasets offline. They never receive browsing data.

The product must not send originals, frames, crops, URLs, hashes, embeddings, scores or page-derived diagnostics to any service, including localhost. The permission to display media in a tab does not imply permission to forward it. Only content the browser permits the extension to read may be scanned. Optional source reads, if implemented, must prove that the bytes belong to the rendered media. They may only retrieve the existing eligible object from its original host, without credentials or referrer.

Runtime GraphQL, FastAPI, PostgreSQL, hosted jobs, cloud watermark APIs, URL lookups, transfers for thin devices, accounts and analytics are outside this architecture. Do not retain a dormant server fallback. Ship local model, runtime and trust data with the extension. A stale trust list or failed model yields no label through that route. The UI consumes only a scoped, versioned local decision.

Use WXT targets for Chromium and Safari and validate the generated packages separately. A shared build, Playwright WebKit, or the presence of a browser API in documentation does not establish a Safari extension runtime pass. Treat iOS/iPadOS and Chromium products with restricted extension support as distinct distribution or validation targets.
