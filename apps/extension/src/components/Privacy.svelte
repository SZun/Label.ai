<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '@smui/button';
  import { browser } from 'wxt/browser';
  import { CONSENT_VERSION, DEFAULT_SETTINGS, normalizeOrigin, type LocalSettings } from '../core/policy';
  import { readSettings, writeSettings } from '../transport/settings';
  let settings: LocalSettings = $state({ ...DEFAULT_SETTINGS });
  let site = $state('');
  let message = $state('');
  onMount(async () => { settings = await readSettings(); });

  async function enable() {
    const origin = normalizeOrigin(site.trim());
    if (!origin) { message = 'Enter a public HTTPS site address.'; return; }
    // Permission request remains directly inside the user gesture.
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) { message = 'Site access was not granted. Nothing will be analyzed.'; return; }
    settings = { enabled: true, consentVersion: CONSENT_VERSION, approvedOrigins: [...new Set([...settings.approvedOrigins, origin])] };
    await writeSettings(settings);
    message = 'Local analysis enabled. Reload existing pages on this site.';
  }
  async function pause() { settings = { ...settings, enabled: false }; await writeSettings(settings); message = 'Paused. Existing labels have been removed.'; }
  async function remove(origin: string) {
    settings = { ...settings, approvedOrigins: settings.approvedOrigins.filter((entry) => entry !== origin) };
    await writeSettings(settings);
    await browser.permissions.remove({ origins: [`${origin}/*`] });
  }
  async function clear() {
    const origins = settings.approvedOrigins.map((origin) => `${origin}/*`);
    settings = { ...DEFAULT_SETTINGS };
    await writeSettings(settings);
    await browser.runtime.sendMessage({ type: 'label-ai:clear' });
    if (origins.length) await browser.permissions.remove({ origins });
    message = 'Local settings and in-memory analysis results cleared.';
  }
</script>

<svelte:head><title>Label.ai privacy and site access</title></svelte:head>
<main>
  <p class="brand">Label.ai</p>
  <h1>Your media stays on your device.</h1>
  <p>Label.ai analyzes visible images and video frames locally. It never uploads media, screenshots, hashes, browsing history or detection results. It has no cloud fallback or analytics.</p>
  <p>Enable access only on public sites you want analyzed. Private-message, account, payment and password pages are excluded. Inaccessible media stays unlabeled.</p>
  <p>Some publishers provide content-addressed images. Label.ai may download those images from the same site, without cookies, to verify their signed credentials on your device. It never sends them elsewhere.</p>
  <p>A label indicates an enabled detection policy found sufficient evidence. Missing labels do not prove authenticity. Experimental forensic models remain disabled for positive labels until independently validated.</p>
  <section aria-labelledby="site-heading">
    <h2 id="site-heading">Site access</h2>
    <label for="site">Site address</label>
    <input id="site" type="url" bind:value={site} placeholder="https://example.com" autocomplete="off" />
    <Button variant="raised" onclick={enable}>Enable on this site</Button>
    <p class="small">Enabling confirms local media analysis on the public pages of this site. Your browser will also ask for site access.</p>
    {#if settings.approvedOrigins.length}<ul>{#each settings.approvedOrigins as origin}<li><span>{origin}</span><Button onclick={() => remove(origin)} aria-label={`Remove ${origin}`}>Remove</Button></li>{/each}</ul>{/if}
    <div class="actions"><Button onclick={pause}>Pause local analysis</Button><Button onclick={clear}>Clear local data</Button></div>
    <p role="status">{message}</p>
  </section>
</main>

<style>
  :global(body) { margin: 0; background: #fafafa; color: #212121; font-family: system-ui, sans-serif; }
  main { max-width: 680px; margin: 48px auto; padding: 0 24px; }
  .brand { font-weight: 700; font-size: 18px; }
  h1 { font-size: 32px; line-height: 1.2; margin-bottom: 24px; }
  h2 { font-size: 20px; }
  p { line-height: 1.6; }
  section { border-top: 1px solid #ddd; margin-top: 28px; padding-top: 12px; }
  label { display: block; font-weight: 600; margin-bottom: 8px; }
  input { display: block; box-sizing: border-box; width: 100%; border: 1px solid #555; border-radius: 4px; padding: 12px; font: inherit; margin-bottom: 12px; }
  .small { font-size: 13px; color: #555; }
  ul { list-style: none; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  :global(.mdc-button) { border: 0; border-radius: 20px; padding: 10px 18px; color: #7f0000; background: #f4e9e9; font: 600 14px system-ui, sans-serif; cursor: pointer; }
  :global(.mdc-button--raised) { color: #fff; background: #b71c1c; }
  :global(button:focus-visible), input:focus-visible { outline: 3px solid #1557a2; outline-offset: 3px; }
  :global(.mdc-button__ripple), :global(.mdc-button__touch) { display: none; }
  @media (max-width: 480px) { main { margin-top: 24px; } h1 { font-size: 26px; } }
</style>
