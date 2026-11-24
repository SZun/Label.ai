<script lang="ts">
  import Paper from '@smui/paper';
  let { animate = true }: { animate?: boolean } = $props();
</script>

<Paper class={`slop-label${animate ? ' label--new' : ''}`} elevation={2}>
  AI Slop Detected <span aria-hidden="true">🤮</span>
</Paper>
