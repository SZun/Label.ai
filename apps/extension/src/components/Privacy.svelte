<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '@smui/button';
  import { browser } from 'wxt/browser';
  import {
    CONSENT_VERSION,
    DEFAULT_SETTINGS,
    hostPermissionPattern,
    normalizeOrigin,
    type LocalSettings,
  } from '../core/policy';
  import { readSettings, writeSettings } from '../transport/settings';
  let settings: LocalSettings = $state({ ...DEFAULT_SETTINGS });
  let site = $state('');
  let message = $state('');
  let busy = $state(true);
  onMount(async () => {
    try {
      settings = await readSettings();
    } catch {
      message = 'Local settings could not be loaded. Reopen this page to try again.';
    } finally {
      busy = false;
    }
  });

  async function enable() {
    if (busy) return;
    const origin = normalizeOrigin(site.trim());
    if (!origin) {
      message = 'Enter a public HTTPS site address.';
      return;
    }
    busy = true;
    message = '';
    try {
      const permission = { origins: [hostPermissionPattern(origin)!] };
      // Request directly in the user gesture. Safari may reject or deny a redundant
      // request; an existing grant counts only when the browser confirms it.
      const request = browser.permissions.request(permission).catch(() => false);
      const existing = browser.permissions.contains(permission).catch(() => false);
      const alreadyGranted = new Promise<boolean>((resolve) => {
        void existing.then((granted) => {
          if (granted) resolve(true);
        });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 30_000);
      });
      const granted = await Promise.race([
        request.then(async (granted) => granted || (await existing)),
        alreadyGranted,
        expired,
      ]);
      clearTimeout(timer);
      if (!granted) {
        message =
          'Site access was not granted. Check this website’s browser extension permission and try again.';
        return;
      }
      const previous = await readSettings();
      if (!previous.approvedOrigins.includes(origin) && previous.approvedOrigins.length >= 100) {
        message = 'The site limit has been reached. Remove an approved site and try again.';
        return;
      }
      const next = {
        enabled: true,
        consentVersion: CONSENT_VERSION,
        approvedOrigins: [...new Set([...previous.approvedOrigins, origin])],
      };
      await writeSettings(next);
      settings = next;
      const registration = await browser.runtime.sendMessage({ type: 'label-ai:sync' });
      if (!registration?.registered) throw new Error('Registration failed');
      message = 'Local analysis enabled. Reload existing pages on this site.';
    } catch {
      message =
        'Label.ai could not activate this site. Check the browser extension permission and try again.';
    } finally {
      busy = false;
    }
  }

  async function pause() {
    if (busy) return;
    busy = true;
    try {
      const next = { ...(await readSettings()), enabled: false };
      await writeSettings(next);
      settings = next;
      message = 'Paused. Existing labels have been removed.';
    } catch {
      message = 'Pausing failed. Try again or disable Label.ai in your browser.';
    } finally {
      busy = false;
    }
  }

  async function remove(origin: string) {
    if (busy) return;
    busy = true;
    try {
      const previous = await readSettings();
      const next = {
        ...previous,
        approvedOrigins: previous.approvedOrigins.filter((entry) => entry !== origin),
      };
      await writeSettings(next);
      settings = next;
      const pattern = hostPermissionPattern(origin)!;
      if (!next.approvedOrigins.some((entry) => hostPermissionPattern(entry) === pattern))
        if (!(await browser.permissions.remove({ origins: [pattern] }))) {
          message =
            'Local consent removed. To withdraw the remaining browser grant, use browser settings.';
          return;
        }
      message = 'Site access removed.';
    } catch {
      message =
        'Removing site access could not finish. Check the browser extension settings and try again.';
    } finally {
      busy = false;
    }
  }

  async function clear() {
    if (busy) return;
    busy = true;
    try {
      const previous = await readSettings();
      const origins = [
        ...new Set(previous.approvedOrigins.map((origin) => hostPermissionPattern(origin)!)),
      ];
      await writeSettings({ ...DEFAULT_SETTINGS });
      settings = { ...DEFAULT_SETTINGS };
      const [clearResult, permissionResult] = await Promise.allSettled([
        browser.runtime.sendMessage({ type: 'label-ai:clear' }),
        origins.length ? browser.permissions.remove({ origins }) : Promise.resolve(true),
      ]);
      if (
        clearResult.status !== 'fulfilled' ||
        !clearResult.value?.cleared ||
        permissionResult.status !== 'fulfilled' ||
        !permissionResult.value
      ) {
        message =
          'Local consent cleared. Check browser permissions and reopen Label.ai to try clearing again.';
        return;
      }
      message = 'Local settings and in-memory analysis results cleared.';
    } catch {
      message = 'Clearing could not finish. Check browser extension settings and try again.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Label.ai privacy and site access</title></svelte:head>
<main>
  <p class="brand">Label.ai</p>
  <h1>Your media stays on your device.</h1>
  <p>
    Label.ai analyzes visible images and video frames locally. It never uploads media, screenshots,
    hashes, browsing history or detection results. It has no cloud fallback or analytics.
  </p>
  <p>
    Enable access only on public sites you want analyzed. Private-message, account, payment and
    password pages are excluded. Inaccessible media stays unlabeled.
  </p>
  <p>
    Some publishers provide content-addressed images. Label.ai may download those images from the
    same site, without cookies, to verify their signed credentials on your device. It never sends
    them elsewhere.
  </p>
  <p>
    A label indicates an enabled detection policy found sufficient evidence. Missing labels do not
    prove authenticity. Experimental forensic models remain disabled for positive labels until
    independently validated.
  </p>
  <section aria-labelledby="site-heading">
    <h2 id="site-heading">Site access</h2>
    <label for="site">Site address</label>
    <input
      id="site"
      type="url"
      bind:value={site}
      disabled={busy}
      placeholder="https://example.com"
      autocomplete="off"
    />
    <Button variant="raised" onclick={enable} disabled={busy}>Enable on this site</Button>
    <p class="small">
      Enabling confirms local media analysis on the public pages of this site. Your browser will
      also ask for site access.
    </p>
    {#if settings.approvedOrigins.length}<ul>
        {#each settings.approvedOrigins as origin}<li>
            <span>{origin}</span><Button
              onclick={() => remove(origin)}
              disabled={busy}
              aria-label={`Remove ${origin}`}>Remove</Button
            >
          </li>{/each}
      </ul>{/if}
    <div class="actions">
      <Button onclick={pause} disabled={busy}>Pause local analysis</Button><Button
        onclick={clear}
        disabled={busy}>Clear local data</Button
      >
    </div>
    <p role="status">{message}</p>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #fafafa;
    color: #212121;
    font-family: system-ui, sans-serif;
  }
  main {
    max-width: 680px;
    margin: 48px auto;
    padding: 0 24px;
  }
  .brand {
    font-weight: 700;
    font-size: 18px;
  }
  h1 {
    font-size: 32px;
    line-height: 1.2;
    margin-bottom: 24px;
  }
  h2 {
    font-size: 20px;
  }
  p {
    line-height: 1.6;
  }
  section {
    border-top: 1px solid #ddd;
    margin-top: 28px;
    padding-top: 12px;
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 8px;
  }
  input {
    display: block;
    box-sizing: border-box;
    width: 100%;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 12px;
    font: inherit;
    margin-bottom: 12px;
  }
  .small {
    font-size: 13px;
    color: #555;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  :global(.mdc-button) {
    border: 0;
    border-radius: 20px;
    padding: 10px 18px;
    color: #7f0000;
    background: #f4e9e9;
    font:
      600 14px system-ui,
      sans-serif;
    cursor: pointer;
  }
  :global(.mdc-button--raised) {
    color: #fff;
    background: #b71c1c;
  }
  :global(button:focus-visible),
  input:focus-visible {
    outline: 3px solid #1557a2;
    outline-offset: 3px;
  }
  :global(.mdc-button__ripple),
  :global(.mdc-button__touch) {
    display: none;
  }
  @media (max-width: 480px) {
    main {
      margin-top: 24px;
    }
    h1 {
      font-size: 26px;
    }
  }
</style>
