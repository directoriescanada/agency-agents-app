<script lang="ts" module>
  export interface BarItem {
    key: string;
    label: string;
    value: number;
    /** Colour of the dot in front of the label: who the row is, or its status. */
    dot?: string;
    /** Draw the dot faded (a tool that is not detected, say). */
    dotDim?: boolean;
    /** Text for the value column; the bare number when omitted. */
    display?: string;
    title?: string;
    onClick?: () => void;
  }
</script>

<script lang="ts">
  /**
   * A ranked list of horizontal bars: label, bar, value. One measure, one
   * colour; the dot in front of the label carries identity, the bar only
   * length. Rows are buttons when they lead somewhere.
   */
  interface Props {
    items: BarItem[];
  }
  let { items }: Props = $props();

  const max = $derived(Math.max(1, ...items.map((i) => i.value)));
</script>

{#snippet body(it: BarItem)}
  {#if it.dot}<span class="dot" class:dim={it.dotDim} style="background:{it.dot}"></span>{/if}
  <span class="label">{it.label}</span>
  <span class="track"><span class="fill" style="width:{(it.value / max) * 100}%"></span></span>
  <span class="count">{it.display ?? it.value}</span>
{/snippet}

<ul class="bars">
  {#each items as it (it.key)}
    <li>
      {#if it.onClick}
        <button class="bar link" onclick={it.onClick} title={it.title}>{@render body(it)}</button>
      {:else}
        <div class="bar" title={it.title}>{@render body(it)}</div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .bars { display: flex; flex-direction: column; gap: 2px; }
  .bar {
    display: flex; align-items: center; gap: var(--space-2); width: 100%;
    padding: 6px var(--space-2); border-radius: var(--radius-sm);
    background: transparent; text-align: left;
  }
  .bar.link { cursor: pointer; }
  .bar.link:hover { background: var(--color-surface-sunken); }
  .bar.link:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }
  .dot { width: 8px; height: 8px; border-radius: var(--radius-full); flex: none; }
  .dot.dim { opacity: 0.5; }
  .label { width: 116px; font-size: var(--text-body-sm); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
  .track { flex: 1; height: 6px; background: var(--color-surface-sunken); border-radius: var(--radius-full); overflow: hidden; min-width: 24px; }
  .bar.link:hover .track { background: var(--color-border); }
  .fill { display: block; height: 100%; background: var(--color-brand); border-radius: var(--radius-full); }
  .count { min-width: 30px; text-align: right; font-size: var(--text-caption); color: var(--color-text-muted); font-variant-numeric: tabular-nums; flex: none; }
</style>
