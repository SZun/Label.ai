<script lang="ts">
  import Paper from '@smui/paper';
  import { untrack } from 'svelte';
  let { animate = true }: { animate?: boolean } = $props();
  // Keep the entrance class until this keyed badge is unmounted. Layout updates
  // must not interrupt its CSS animation, and a remount can opt out.
  const animateOnMount = untrack(() => animate);
</script>

<Paper class={`slop-label${animateOnMount ? ' label--new' : ''}`} elevation={2}>
  AI Slop Detected <span aria-hidden="true">🤮</span>
</Paper>
