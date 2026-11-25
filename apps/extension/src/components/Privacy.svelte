<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '@smui/button';
  import { browser } from 'wxt/browser';
  import { DEFAULT_SETTINGS, type LocalSettings } from '../core/policy';
  import {
    LOCAL_TEST_BUILD,
    LOCAL_TEST_IMAGE_THRESHOLD,
    LOCAL_TEST_VIDEO_THRESHOLD,
  } from '../core/local-test';
  import { readSettings, writeSettings } from '../transport/settings';

  let settings: LocalSettings = $state({ ...DEFAULT_SETTINGS, enabled: false });
  let message = $state('Loading scanning status…');
  let busy = $state(true);
  let loaded = $state(false);

  onMount(async () => {
    try {
      settings = await readSettings();
      message = settings.enabled ? 'Automatic scanning is on.' : 'Scanning is paused.';
      loaded = true;
    } catch {
      message = 'Local settings could not be loaded. Reopen this page to try again.';
    } finally {
      busy = false;
    }
  });

  async function setEnabled(enabled: boolean) {
    if (busy || !loaded) return;
    busy = true;
    try {
      const next = { ...DEFAULT_SETTINGS, enabled };
      await writeSettings(next);
      settings = next;
      const registration = await browser.runtime.sendMessage({ type: 'label-ai:sync' });
      if (!registration?.registered) throw new Error('Registration failed');
      message = enabled
        ? 'Scanning resumed.'
        : 'Scanning paused. Existing labels have been removed.';
    } catch {
      if (enabled) {
        try {
          await writeSettings({ ...DEFAULT_SETTINGS, enabled: false });
          settings = { ...DEFAULT_SETTINGS, enabled: false };
        } catch {
          // The browser permission still controls whether any page may be scanned.
        }
      }
      message = enabled
        ? 'Could not resume scanning. Check browser extension access and try again.'
        : 'Could not finish pausing. Try again or disable Label.ai in your browser.';
    } finally {
      busy = false;
    }
  }

  async function clear() {
    if (busy || !loaded) return;
    busy = true;
    try {
      const next = { ...DEFAULT_SETTINGS, enabled: false };
      await writeSettings(next);
      settings = next;
      const result = await browser.runtime.sendMessage({ type: 'label-ai:clear' });
      if (!result?.cleared) throw new Error('Clear failed');
      message = 'Local data cleared. Scanning remains paused.';
    } catch {
      message = 'Clearing could not finish. Check browser extension settings and try again.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head
  ><title>{LOCAL_TEST_BUILD ? 'Label.ai (Local Test)' : 'Label.ai privacy and site access'}</title
  ></svelte:head
>
<main>
  <p class="brand">{LOCAL_TEST_BUILD ? 'Label.ai (Local Test)' : 'Label.ai'}</p>
  <h1>Your media stays on your device.</h1>
  <p>
    Label.ai analyzes visible images and video frames locally. It never uploads media, screenshots,
    hashes, browsing history or detection results. It has no cloud fallback or analytics.
  </p>
  {#if LOCAL_TEST_BUILD}
    <aside class="test-notice" aria-label="Experimental test build">
      <strong>Experimental local test build</strong>
      <p>
        This build automatically scans HTTP loopback pages granted by your browser. Image labels use
        an exploratory raw model threshold of {LOCAL_TEST_IMAGE_THRESHOLD}; video labels require
        eligible temporal evidence and a raw score of at least {LOCAL_TEST_VIDEO_THRESHOLD}. These
        raw scores are uncalibrated. False positives and missed AI media are possible.
      </p>
      <p>
        Use a regular browser window and disable the normal Label.ai extension to avoid duplicate
        labels.
      </p>
    </aside>
  {:else}
    <p>
      Label.ai automatically scans eligible websites as soon as your browser grants extension
      access. Private-message, account, payment and password pages are excluded. Inaccessible media
      stays unlabeled.
    </p>
  {/if}
  <p>
    Some publishers provide content-addressed images. Label.ai may download those images from the
    same site, without cookies, to verify their signed credentials on your device. It never sends
    them elsewhere. For public CDN images and short MP4 or WebM videos, it may request the selected
    file anonymously when the CDN permits access. Video analysis uses frames observed during
    playback. The CDN can see the page origin.
  </p>
  {#if !LOCAL_TEST_BUILD}
    <p>
      Labels can come from a verified AI-generation credential or a local model estimate. Model
      estimates can flag genuine images and miss generated ones. Video estimates also require
      consistent evidence across visible playback frames.
    </p>
  {/if}
  <section aria-labelledby="site-heading">
    <h2 id="site-heading">Automatic scanning</h2>
    <p>Site access is managed by your browser. You can pause scanning everywhere at any time.</p>
    <div class="actions">
      {#if settings.enabled}
        <Button variant="raised" onclick={() => setEnabled(false)} disabled={busy || !loaded}>
          Pause scanning
        </Button>
      {:else}
        <Button variant="raised" onclick={() => setEnabled(true)} disabled={busy || !loaded}>
          Resume scanning
        </Button>
      {/if}
      <Button onclick={clear} disabled={busy || !loaded}>Clear local data</Button>
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
  .test-notice {
    border: 1px solid #a85a00;
    border-radius: 4px;
    padding: 16px;
    background: #fff3e0;
    color: #542c00;
  }
  .test-notice p {
    margin-bottom: 0;
  }
  section {
    border-top: 1px solid #ddd;
    margin-top: 28px;
    padding-top: 12px;
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
  :global(button:focus-visible) {
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
