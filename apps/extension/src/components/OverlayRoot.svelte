<script lang="ts" module>
  export interface LabelPlacement { key: string; x: number; y: number; animate: boolean }
</script>
<script lang="ts">
  import SlopLabel from './SlopLabel.svelte';
  let labels: LabelPlacement[] = $state([]);
  export function setLabels(next: LabelPlacement[]) { labels = next; }
</script>

{#each labels as label (label.key)}
  <div class="label-anchor" style={`left:${label.x}px;top:${label.y}px`}>
    <SlopLabel animate={label.animate} />
  </div>
{/each}
