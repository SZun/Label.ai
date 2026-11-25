<script lang="ts" module>
  export interface LabelPlacement {
    key: string;
    x: number;
    y: number;
    width: number;
    compact: boolean;
    animate: boolean;
  }
</script>

<script lang="ts">
  import SlopLabel from './SlopLabel.svelte';
  let labels: LabelPlacement[] = $state([]);
  export function setLabels(next: LabelPlacement[]) {
    labels = next;
  }
</script>

{#each labels as label (label.key)}
  <div
    class="label-anchor"
    class:compact={label.compact}
    style={`left:${label.x}px;top:${label.y}px;width:${label.width}px`}
  >
    <SlopLabel animate={label.animate} />
  </div>
{/each}
