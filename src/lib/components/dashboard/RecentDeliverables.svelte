<script lang="ts">
  /**
   * The latest finished tasks: how each ended, who did it, when, how long it
   * took and what it cost. A row opens the task; the folder button shows the
   * written deliverable in Finder.
   */
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { durationMs } from "$lib/office/stats";
  import { formatCost, formatDuration, formatWhen, revealDeliverable, statusLabel, statusTone } from "$lib/office/format";
  import type { OfficeTask } from "$lib/types";
  import Pill from "../Pill.svelte";

  interface Props {
    /** Finished tasks, newest first. */
    tasks: OfficeTask[];
    now: number;
    onOpen: (taskId: string) => void;
  }
  let { tasks, now, onOpen }: Props = $props();

  const emojiOf = $derived(new Map(corpus.agents.map((a) => [a.slug, a.emoji])));

  /** "Engineering · 14s · $0.19", leaving out what the runner did not report. */
  function meta(t: OfficeTask): string {
    const ms = durationMs(t);
    return [corpus.labelOf(t.department), ms == null ? null : formatDuration(ms), formatCost(t.costUsd)]
      .filter((x) => x)
      .join(" · ");
  }
  const whenOf = (t: OfficeTask) => formatWhen(Date.parse(t.finishedAt ?? t.startedAt), now);
</script>

{#if tasks.length === 0}
  <p class="empty">{i18n.t("dashboard.ops.recentEmpty")}</p>
{:else}
  <ul class="list">
    {#each tasks as t (t.id)}
      <li class="item">
        <button class="open" onclick={() => onOpen(t.id)} title={i18n.t("dashboard.ops.openTask")}>
          <span class="top">
            <Pill tone={statusTone(t)}>{statusLabel(t)}</Pill>
            <span class="agent">{emojiOf.get(t.agentSlug) ? `${emojiOf.get(t.agentSlug)} ` : ""}{t.agentName}</span>
            <span class="when">{whenOf(t)}</span>
          </span>
          <span class="prompt">{t.prompt}</span>
          <span class="meta"><span class="dot" style="background:{corpus.colorOf(t.department)}"></span>{meta(t)}</span>
        </button>
        {#if t.deliverablePath}
          {@const path = t.deliverablePath}
          <button class="reveal" onclick={() => revealDeliverable(path)} title={i18n.t("office.reveal")} aria-label={i18n.t("office.reveal")}>
            <FolderOpen size={15} />
          </button>
        {:else}
          <span class="reveal-gap"></span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty { font-size: var(--text-body-sm); color: var(--color-text-muted); }
  .list { display: flex; flex-direction: column; gap: 2px; margin: 0 calc(var(--space-2) * -1); }
  .item { display: flex; align-items: center; gap: var(--space-1); }
  .open {
    flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px;
    padding: var(--space-2); border-radius: var(--radius-md);
    background: transparent; cursor: pointer; text-align: left;
  }
  .open:hover { background: var(--color-surface-sunken); }
  .open:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }

  .top { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .agent { flex: 1; min-width: 0; font-size: var(--text-body); font-weight: var(--fw-semibold); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { flex: none; font-size: var(--text-caption); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .prompt { font-size: var(--text-body-sm); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-caption); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .dot { width: 7px; height: 7px; border-radius: var(--radius-full); flex: none; }

  .reveal, .reveal-gap { flex: none; width: 30px; height: 30px; }
  .reveal {
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-md); background: transparent;
    color: var(--color-text-muted); cursor: pointer;
  }
  .reveal:hover { background: var(--color-surface-sunken); color: var(--color-text-primary); }
  .reveal:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }
</style>
