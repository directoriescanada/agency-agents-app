<script lang="ts">
  /** Card chrome for the dashboard: title, optional period and action, body. */
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    /** Quiet qualifier next to the title: the period, a count. */
    sub?: string;
    /** Right-aligned control in the header. */
    action?: Snippet;
    children: Snippet;
  }
  let { title, sub, action, children }: Props = $props();
</script>

<section class="card">
  <header class="head">
    <h3 class="title">{title}</h3>
    {#if sub}<span class="sub">{sub}</span>{/if}
    {#if action}<span class="action">{@render action()}</span>{/if}
  </header>
  {@render children()}
</section>

<style>
  .card {
    border: 1px solid var(--color-border); border-radius: var(--radius-lg);
    background: var(--color-surface-raised); padding: var(--space-4); min-width: 0;
    display: flex; flex-direction: column;
  }
  .head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-3); min-height: 18px; }
  .title { font-size: var(--text-body-sm); font-weight: var(--fw-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .sub { font-size: var(--text-caption); color: var(--color-text-muted); }
  .action { margin-left: auto; display: inline-flex; align-items: center; gap: var(--space-2); }
</style>
