<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '@smui/button';
  import { browser } from 'wxt/browser';
  import { statusText, type PlayerStatus } from '../core/player-status';
  let status = $state<PlayerStatus>('searching');
  onMount(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let next: PlayerStatus = 'unavailable';
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null && tab.incognito === false) {
          const result = await browser.tabs.sendMessage(
            tab.id,
            { type: 'label-ai:player-status' },
            { frameId: 0 },
          );
          if (typeof result === 'string' && Object.hasOwn(statusText, result))
            next = result as PlayerStatus;
        }
      } catch {
        /* Browser-restricted pages have no content script. */
      }
      if (!closed) {
        status = next;
        timer = setTimeout(refresh, 1500);
      }
    }
    void refresh();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  });
</script>

<main>
  <h1>Video status</h1>
  <p role="status">{statusText[status]}</p>
  <Button onclick={() => browser.runtime.openOptionsPage()}>Scanning settings</Button>
</main>

<style>
  :global(body) {
    margin: 0;
    font:
      15px/1.5 system-ui,
      sans-serif;
  }
  main {
    width: 280px;
    padding: 18px;
  }
  h1 {
    font-size: 19px;
    margin: 0;
  }
</style>
