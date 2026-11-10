<script lang="ts">
  /**
   * Tasks running right now: who, for which department, on what, for how
   * long, with a Stop on each. A team task is one row under its lead, with
   * the phase it is in; stopping it stops every part. The one dashboard widget that reads the
   * per-second clock, so only its timers re-render every second.
   */
  import Square from "@lucide/svelte/icons/square";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatElapsed, phaseLine, teamLabel } from "$lib/office/format";
  import Button from "../Button.svelte";
  import Pill from "../Pill.svelte";

  interface Props {
    /** Open a task where its live output can be read. */
    onOpen: (taskId: string) => void;
  }
  let { onOpen }: Props = $props();

  const emojiOf = $derived(new Map(corpus.agents.map((a) => [a.slug, a.emoji])));
  /** Longest-running first: the one most likely to need a look. */
  const running = $derived(office.runningTop.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)));
</script>

{#if running.length === 0}
  <p class="empty">{i18n.t("dashboard.ops.inFlightEmpty")}</p>
{:else}
  <ul class="list">
    {#each running as t (t.id)}
      {@const tool = t.toolsUsed.at(-1)}
      {@const phase = phaseLine(t, office.childrenOf(t.id))}
      <li class="item">
        <button class="open" onclick={() => onOpen(t.id)} title={i18n.t("dashboard.ops.openTask")}>
          <span class="live" aria-hidden="true"></span>
          <span class="text">
            <span class="who">
              <span class="agent">{emojiOf.get(t.agentSlug) ? `${emojiOf.get(t.agentSlug)} ` : ""}{t.agentName}</span>
              {#if t.kind === "team"}<Pill tone="brand">{teamLabel(t)}</Pill>{/if}
              <span class="dept"><span class="dot" style="background:{corpus.colorOf(t.department)}"></span>{corpus.labelOf(t.department)}</span>
            </span>
            <span class="prompt">{t.prompt}</span>
            {#if phase}<span class="tool">{phase}</span>{:else if tool}<span class="tool">{i18n.t("dashboard.ops.usingTool", { tool })}</span>{/if}
          </span>
          <span class="timer">{formatElapsed(t, office.now)}</span>
        </button>
        <Button variant="danger" size="sm" onclick={() => office.cancel(t.id)}>
          {#snippet icon()}<Square size={12} />{/snippet}
          {i18n.t("office.stop")}
        </Button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty { font-size: var(--text-body-sm); color: var(--color-text-muted); }
  .list { display: flex; flex-direction: column; gap: 2px; margin: 0 calc(var(--space-2) * -1); }
  .item { display: flex; align-items: center; gap: var(--space-2); padding-right: var(--space-2); }
  .open {
    flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: var(--space-3);
    padding: var(--space-2); border-radius: var(--radius-md);
    background: transparent; cursor: pointer; text-align: left;
  }
  .open:hover { background: var(--color-surface-sunken); }
  .open:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }

  .live { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: var(--radius-full); background: var(--color-info); animation: flight-live 1.6s ease-in-out infinite; }
  @keyframes flight-live {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-info) 45%, transparent); }
    50% { box-shadow: 0 0 0 5px transparent; }
  }
  @media (prefers-reduced-motion: reduce) { .live { animation: none; } }

  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .who { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .agent { font-size: var(--text-body); font-weight: var(--fw-semibold); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dept { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-caption); color: var(--color-text-muted); }
  .dot { width: 7px; height: 7px; border-radius: var(--radius-full); flex: none; }
  .prompt { font-size: var(--text-body-sm); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool { font-size: var(--text-caption); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timer { flex: none; margin-top: 1px; font-family: var(--font-mono); font-size: var(--text-mono); color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
</style>
