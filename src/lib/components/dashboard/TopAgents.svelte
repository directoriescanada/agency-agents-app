<script lang="ts">
  /**
   * Who got the most done in the period: finished tasks and how long one
   * takes them on average. A row opens the agent's page.
   */
  import { corpus } from "$lib/stores/corpus.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatDuration } from "$lib/office/format";
  import type { AgentLoad } from "$lib/office/stats";

  interface Props {
    /** Most finished work first. */
    agents: AgentLoad[];
    onOpen: (agent: AgentLoad) => void;
  }
  let { agents, onOpen }: Props = $props();

  const emojiOf = $derived(new Map(corpus.agents.map((a) => [a.slug, a.emoji])));
</script>

{#if agents.length === 0}
  <p class="empty">{i18n.t("dashboard.ops.noneYet")}</p>
{:else}
  <ul class="list">
    {#each agents as a (a.slug)}
      <li>
        <button class="row" onclick={() => onOpen(a)}>
          <span class="who">
            <span class="agent">{emojiOf.get(a.slug) ? `${emojiOf.get(a.slug)} ` : ""}{a.name}</span>
            <span class="dept"><span class="dot" style="background:{corpus.colorOf(a.department)}"></span>{corpus.labelOf(a.department)}</span>
          </span>
          <span class="figures">
            <span class="done">{i18n.t("dashboard.ops.doneCount", { count: a.done })}</span>
            {#if a.avgMs != null}<span class="avg">{i18n.t("dashboard.ops.avg", { duration: formatDuration(a.avgMs) })}</span>{/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty { font-size: var(--text-body-sm); color: var(--color-text-muted); }
  .list { display: flex; flex-direction: column; gap: 2px; margin: 0 calc(var(--space-2) * -1); }
  .row {
    display: flex; align-items: center; gap: var(--space-3); width: 100%;
    padding: 6px var(--space-2); border-radius: var(--radius-sm);
    background: transparent; cursor: pointer; text-align: left;
  }
  .row:hover { background: var(--color-surface-sunken); }
  .row:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .agent { font-size: var(--text-body-sm); font-weight: var(--fw-medium); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dept { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-caption); color: var(--color-text-muted); }
  .dot { width: 7px; height: 7px; border-radius: var(--radius-full); flex: none; }
  .figures { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-variant-numeric: tabular-nums; }
  .done { font-size: var(--text-body-sm); color: var(--color-text-primary); }
  .avg { font-size: var(--text-caption); color: var(--color-text-muted); }
</style>
