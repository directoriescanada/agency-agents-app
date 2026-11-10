<script lang="ts">
  /**
   * Office — the isometric floor where every catalog agent has a desk, and
   * the task bar that puts them to work.
   *
   * Left: the office (OfficeCanvas). Right: a panel with the composer
   * (department → agent → task), the live feed, and a detail view for the
   * selected task or agent. Tasks run through Claude Code on this machine
   * (see `src-tauri/src/office/mod.rs`); the desk animates while the agent
   * works and the deliverable lands in the feed and on disk.
   */
  import { onMount } from "svelte";

  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { AGENCY_NAME } from "$lib/util/brand";
  import type { Agent, OfficeTask, OfficeTeamPhase } from "$lib/types";
  import type { MessageKey } from "$lib/i18n/messages";
  import { buildDepartments, LOBBY_SLUG } from "$lib/office/scene";
  import {
    formatCost,
    formatElapsed,
    phaseLine,
    revealDeliverable,
    statusLabel,
    statusTone,
    teamLabel,
  } from "$lib/office/format";

  import OfficeCanvas from "./OfficeCanvas.svelte";
  import OfficeComposer from "./OfficeComposer.svelte";
  import Button from "./Button.svelte";
  import Pill from "./Pill.svelte";

  import Square from "@lucide/svelte/icons/square";
  import Maximize from "@lucide/svelte/icons/maximize";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import Wrench from "@lucide/svelte/icons/wrench";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Check from "@lucide/svelte/icons/check";

  let canvasRef: OfficeCanvas | undefined = $state();

  onMount(() => {
    void corpus.ensureLoaded();
    void office.start();
  });

  // ---------- Roster → scene ----------
  const departments = $derived(
    buildDepartments(corpus.agents, (slug) => corpus.labelOf(slug), (slug) => corpus.colorOf(slug)),
  );

  const selectedAgent: Agent | null = $derived(
    office.selectedAgent ? (corpus.agents.find((a) => a.slug === office.selectedAgent) ?? null) : null,
  );
  const selectedTask: OfficeTask | null = $derived(
    office.selectedTask ? (office.tasks.find((t) => t.id === office.selectedTask) ?? null) : null,
  );

  // ---------- Picks from the floor ----------
  function pickAgent(slug: string) {
    office.selectedAgent = slug;
    office.selectedTask = null;
    const a = corpus.agents.find((x) => x.slug === slug);
    if (a) {
      office.composerDepartment = a.category;
      office.composerAgent = a.slug;
      // In team mode the desk you click is the lead.
      office.composerLead = a.slug;
    }
  }
  function pickPod(slug: string) {
    office.selectedAgent = null;
    office.selectedTask = null;
    canvasRef?.focusPod(slug);
    // The lobby is a place to look at, not a department to send work to.
    if (slug === LOBBY_SLUG) return;
    office.composerDepartment = slug;
    office.composerAgent = null;
    office.composerLead = null;
  }
  function pickNothing() {
    office.selectedAgent = null;
    office.selectedTask = null;
  }

  function emojiOf(slug: string): string {
    return corpus.agents.find((a) => a.slug === slug)?.emoji ?? "";
  }

  // ---------- Team tasks ----------
  /** The steps of a team task, in order. */
  const STEPS: readonly OfficeTeamPhase[] = ["planning", "working", "merging"];
  /** How far a team task has got: the step it is on, or past the last one when merged. */
  function stepOf(t: OfficeTask): number {
    const i = STEPS.indexOf(t.phase ?? "planning");
    return i < 0 ? STEPS.length : i;
  }
  /** What a team task spent in all, lead and parts together. */
  function teamCost(t: OfficeTask): string | null {
    const amount = formatCost(office.totalCost(t));
    return amount ? i18n.t("office.teamCost", { amount }) : null;
  }
</script>

<div class="office">
  <div class="floor">
    {#if corpus.agents.length === 0}
      <div class="floor-empty">{i18n.t("office.loadingRoster")}</div>
    {/if}
    <OfficeCanvas
      bind:this={canvasRef}
      {departments}
      agencyName={AGENCY_NAME}
      selectedAgent={office.selectedAgent}
      selectedPod={office.composerDepartment}
      onPickAgent={pickAgent}
      onPickPod={pickPod}
      onPickNothing={pickNothing}
    />
    <div class="floor-controls" role="group" aria-label={i18n.t("office.view")}>
      <button class="ctl" title={i18n.t("office.zoomIn")} onclick={() => canvasRef?.zoomBy(1.25)}><ZoomIn size={15} /></button>
      <button class="ctl" title={i18n.t("office.zoomOut")} onclick={() => canvasRef?.zoomBy(0.8)}><ZoomOut size={15} /></button>
      <button class="ctl" title={i18n.t("office.fit")} onclick={() => canvasRef?.fit()}><Maximize size={15} /></button>
    </div>
    <div class="floor-legend">
      <span class="dot idle"></span>{i18n.t("office.legend.idle")}
      <span class="dot working"></span>{i18n.t("office.legend.working")}
      <span class="dot done"></span>{i18n.t("office.legend.done")}
    </div>
  </div>

  <aside class="panel">
    <!-- Runner status -->
    <div class="runner" class:ok={office.runnerReady} class:missing={office.runnerChecked && !office.runnerReady}>
      {#if !office.runnerChecked}
        <span class="runner-dot"></span>{i18n.t("office.runner.checking")}
      {:else if office.runner?.available && office.runner.loggedIn === false}
        <span class="runner-dot"></span>
        <span>{i18n.t("office.runner.signedOut")}</span>
        <button class="runner-retry" title={i18n.t("office.runner.retry")} onclick={() => office.refreshRunner()}><RefreshCw size={12} /></button>
      {:else if office.runner?.available}
        <span class="runner-dot"></span>{i18n.t("office.runner.ready", { version: office.runner.version ?? "" })}
      {:else}
        <span class="runner-dot"></span>
        <span>{i18n.t("office.runner.missing")}</span>
        <button class="runner-retry" title={i18n.t("office.runner.retry")} onclick={() => office.refreshRunner()}><RefreshCw size={12} /></button>
      {/if}
    </div>

    <OfficeComposer />

    <!-- Detail or feed -->
    {#if selectedTask}
      {@const t = selectedTask}
      {@const team = t.kind === "team"}
      {@const lead = office.parentOf(t)}
      {@const parts = team ? office.childrenOf(t.id) : []}
      {@const at = stepOf(t)}
      <section class="detail">
        {#if lead}
          <button class="back" onclick={() => (office.selectedTask = lead.id)}><ChevronLeft size={14} /> {i18n.t("office.backToTeam")}</button>
        {:else}
          <button class="back" onclick={() => (office.selectedTask = null)}><ChevronLeft size={14} /> {i18n.t("office.backToFeed")}</button>
        {/if}
        <header class="detail-head">
          <div class="who">{emojiOf(t.agentSlug)} <strong>{t.agentName}</strong> <span class="muted">· {corpus.labelOf(t.department)}</span></div>
          <div class="meta">
            {#if team}<Pill tone="brand">{teamLabel(t)}</Pill>{/if}
            <Pill tone={statusTone(t)}>{statusLabel(t)}</Pill>
            <span class="muted">{formatElapsed(t, office.now)}</span>
            {#if team}
              {#if teamCost(t)}<span class="muted">· {teamCost(t)}</span>{/if}
            {:else}
              {#if t.numTurns != null}<span class="muted">· {i18n.count(t.numTurns, "office.turn.one", "office.turn.many")}</span>{/if}
              {#if formatCost(t.costUsd)}<span class="muted">· {formatCost(t.costUsd)}</span>{/if}
            {/if}
          </div>
        </header>
        {#if lead}
          <p class="partof">{i18n.t("office.partOf", { lead: lead.agentName })}</p>
        {/if}
        {#if t.brief}
          <div class="brief">
            <span class="brief-label">{i18n.t("office.brief")}</span>
            <p>{t.brief}</p>
          </div>
          <p class="prompt whole">{t.prompt}</p>
        {:else}
          <p class="prompt">{t.prompt}</p>
        {/if}
        {#if team}
          <ol class="steps" aria-label={i18n.t("office.steps")}>
            {#each STEPS as step, i (step)}
              <li
                class="step"
                class:done={at > i}
                class:active={at === i && t.status === "running"}
                class:halted={at === i && t.status !== "running"}
                aria-current={at === i ? "step" : undefined}
              >
                <span class="step-dot">{#if at > i}<Check size={11} strokeWidth={3} />{:else}{i + 1}{/if}</span>
                <span class="step-name">{i18n.t(`office.step.${step}` as MessageKey)}</span>
              </li>
            {/each}
          </ol>
          {#if parts.length > 0}
            <h3 class="sub">
              {i18n.t("office.parts")}
              <span class="tally">{i18n.t("office.partsIn", { done: parts.filter((p) => p.status === "done").length, total: parts.length })}</span>
            </h3>
            <ul class="feed">
              {#each parts as p (p.id)}
                <li><button class="feed-item" onclick={() => (office.selectedTask = p.id)}>
                  <span class="fi-top">
                    <span class="fi-who">{emojiOf(p.agentSlug)} {p.agentName}</span>
                    <Pill tone={statusTone(p)}>{statusLabel(p)}</Pill>
                  </span>
                  <span class="fi-prompt">{p.brief ?? p.prompt}</span>
                  <span class="fi-meta muted">{formatElapsed(p, office.now)}{formatCost(p.costUsd) ? ` · ${formatCost(p.costUsd)}` : ""}</span>
                </button></li>
              {/each}
            </ul>
          {:else if t.status === "running"}
            <p class="muted empty">{i18n.t("office.planning")}</p>
          {/if}
        {/if}
        {#if t.toolsUsed.length > 0}
          <div class="tools"><Wrench size={12} /> {t.toolsUsed.join(", ")}</div>
        {/if}
        {#if !team || t.output || t.phase === "merging" || t.phase === "done"}
          {#if team}<h3 class="sub">{i18n.t("office.merged")}</h3>{/if}
          <div class="output" class:merged={team} class:streaming={t.status === "running"}>
            {#if t.output}
              <pre>{t.output}</pre>
            {:else if t.status === "running"}
              <span class="muted">{i18n.t("office.thinking")}</span>
            {/if}
            {#if t.error}<p class="err">{t.error}</p>{/if}
          </div>
        {:else if t.error}
          <p class="err">{t.error}</p>
        {/if}
        <div class="actions">
          {#if t.status === "running"}
            <Button variant="danger" size="sm" onclick={() => office.cancel(t.id)}>
              {#snippet icon()}<Square size={12} />{/snippet}
              {i18n.t("office.stop")}
            </Button>
          {/if}
          {#if t.deliverablePath}
            <Button variant="secondary" size="sm" onclick={() => revealDeliverable(t.deliverablePath!)}>
              {#snippet icon()}<FolderOpen size={12} />{/snippet}
              {i18n.t("office.reveal")}
            </Button>
          {/if}
        </div>
      </section>
    {:else if selectedAgent}
      {@const a = selectedAgent}
      <section class="detail">
        <button class="back" onclick={pickNothing}><ChevronLeft size={14} /> {i18n.t("office.backToFeed")}</button>
        <header class="detail-head">
          <div class="who big">{a.emoji ?? ""} <strong>{a.name}</strong></div>
          <div class="meta">
            <span class="dept" style="--dept: {corpus.colorOf(a.category)}">{corpus.labelOf(a.category)}</span>
            <Pill tone={office.deskStatus(a.slug) === "working" ? "info" : "neutral"}>{i18n.t(`office.desk.${office.deskStatus(a.slug)}` as Parameters<typeof i18n.t>[0])}</Pill>
          </div>
        </header>
        {#if a.vibe}<p class="vibe">“{a.vibe}”</p>{/if}
        <p class="desc">{a.description}</p>
        <Button variant="secondary" size="sm" onclick={() => { ui.openAgents(a.category); ui.selectAgent(a.slug); }}>{i18n.t("office.openAgent")}</Button>
        <h3 class="sub">{i18n.t("office.agentHistory")}</h3>
        {#if office.tasksFor(a.slug).length === 0}
          <p class="muted">{i18n.t("office.agentIdleHint")}</p>
        {:else}
          <ul class="feed">
            {#each office.tasksFor(a.slug) as t (t.id)}
              <li><button class="feed-item" onclick={() => (office.selectedTask = t.id)}>
                <span class="fi-top"><Pill tone={statusTone(t)}>{statusLabel(t)}</Pill><span class="muted">{formatElapsed(t, office.now)}</span></span>
                <span class="fi-prompt">{t.prompt}</span>
              </button></li>
            {/each}
          </ul>
        {/if}
      </section>
    {:else}
      <section class="feedwrap">
        <h3 class="sub">{i18n.t("office.feed")} {#if office.runningTop.length}<span class="live">{i18n.t("office.live", { count: office.runningTop.length })}</span>{/if}</h3>
        {#if office.feed.length === 0}
          <p class="muted empty">{i18n.t("office.feedEmpty")}</p>
        {:else}
          <ul class="feed">
            {#each office.feed as t (t.id)}
              {@const phase = t.status === "running" ? phaseLine(t, office.childrenOf(t.id)) : null}
              <li><button class="feed-item" onclick={() => (office.selectedTask = t.id)}>
                <span class="fi-top">
                  <span class="fi-who">{emojiOf(t.agentSlug)} {t.agentName}</span>
                  <span class="fi-pills">
                    {#if t.kind === "team"}<Pill tone="brand">{teamLabel(t)}</Pill>{/if}
                    <Pill tone={statusTone(t)}>{statusLabel(t)}</Pill>
                  </span>
                </span>
                <span class="fi-prompt">{t.prompt}</span>
                {#if phase}
                  <span class="fi-meta fi-phase">{phase}</span>
                {/if}
                <span class="fi-meta muted">{corpus.labelOf(t.department)} · {formatElapsed(t, office.now)}{t.kind !== "team" && t.toolsUsed.length ? ` · ${t.toolsUsed.length} ${i18n.t("office.toolsShort")}` : ""}</span>
              </button></li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
    {#if office.error}<p class="err">{office.error}</p>{/if}
  </aside>
</div>

<style>
  .office {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    height: 100%;
    min-height: 0;
  }
  .floor {
    position: relative;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--color-border);
  }
  .floor-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--color-text-muted);
    font-size: 13px;
    z-index: 1;
    pointer-events: none;
  }
  .floor-controls {
    position: absolute;
    right: 12px;
    top: 12px;
    display: flex;
    gap: 4px;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 3px;
    box-shadow: var(--shadow-sm);
  }
  .ctl {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .ctl:hover { background: var(--color-surface-sunken); color: var(--color-text-primary); }
  .floor-legend {
    position: absolute;
    left: 12px;
    bottom: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 4px 10px;
    pointer-events: none;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-left: 6px; }
  .dot:first-child { margin-left: 0; }
  .dot.idle { background: var(--color-text-muted); opacity: 0.5; }
  .dot.working { background: rgb(120 200 255); box-shadow: 0 0 6px rgb(120 200 255 / 0.8); }
  .dot.done { background: var(--color-success); }

  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--color-surface);
  }
  .runner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    font-size: 11.5px;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
  }
  .runner-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-border-strong); flex: none; }
  .runner.ok .runner-dot { background: var(--color-success); }
  .runner.missing { color: var(--color-warning-strong); background: var(--color-warning-subtle); }
  .runner.missing .runner-dot { background: var(--color-warning); }
  .runner-retry { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }

  .feedwrap, .detail {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sub {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .live {
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    color: rgb(60 150 220);
    background: var(--color-info-subtle);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .feed-item {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    cursor: pointer;
    font: inherit;
  }
  .feed-item:hover { border-color: var(--color-border-strong); }
  .fi-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; }
  .fi-who { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fi-prompt { font-size: 12.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .fi-pills { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .fi-meta { font-size: 11px; }
  .fi-phase { color: var(--color-info-on-subtle, var(--color-info)); font-weight: var(--fw-medium); }
  .tally { font-weight: var(--fw-medium); text-transform: none; letter-spacing: 0; }
  .muted { color: var(--color-text-muted); }
  .empty { font-size: 12.5px; line-height: 1.45; }

  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: 0;
    background: transparent;
    color: var(--color-text-link);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 0;
  }
  .detail-head { display: flex; flex-direction: column; gap: 6px; }
  .who { font-size: 13px; }
  .who.big { font-size: 16px; }
  .meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; flex-wrap: wrap; }
  .dept {
    font-size: 11px;
    font-weight: 600;
    color: var(--dept);
    border: 1px solid color-mix(in srgb, var(--dept) 50%, transparent);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .prompt { margin: 0; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; color: var(--color-text-secondary); }
  .prompt.whole { font-size: 11.5px; color: var(--color-text-muted); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .partof { margin: 0; font-size: 11.5px; color: var(--color-text-muted); }
  .brief {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-left: 3px solid var(--color-brand);
    border-radius: 0 8px 8px 0;
    background: var(--color-brand-subtle);
  }
  .brief-label { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-text-muted); }
  .brief p { margin: 0; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; }

  /* Plan → Work → Merge */
  .steps { list-style: none; margin: 2px 0; padding: 0; display: flex; align-items: center; gap: 6px; }
  .step { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--color-text-muted); flex: none; }
  .step + .step::before { content: ""; width: 22px; height: 2px; border-radius: 1px; background: var(--color-border-strong); }
  .step.done + .step::before { background: var(--color-success); }
  .step-dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    font-size: 10px;
    font-weight: 700;
    border: 1.5px solid var(--color-border-strong);
    color: var(--color-text-muted);
    background: var(--color-surface);
  }
  .step.done { color: var(--color-text-secondary); }
  .step.done .step-dot { border-color: var(--color-success); background: var(--color-success); color: var(--color-text-inverse); }
  .step.active { color: var(--color-text-primary); font-weight: 600; }
  .step.active .step-dot { border-color: var(--color-info); background: var(--color-info); color: var(--color-text-inverse); animation: step-pulse 1.6s ease-in-out infinite; }
  .step.halted { color: var(--color-danger); font-weight: 600; }
  .step.halted .step-dot { border-color: var(--color-danger); color: var(--color-danger); }
  @keyframes step-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-info) 45%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-info) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .step.active .step-dot { animation: none; }
  }
  .vibe { margin: 0; font-size: 12.5px; font-style: italic; color: var(--color-text-secondary); }
  .desc { margin: 0; font-size: 12.5px; line-height: 1.45; }
  .tools { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-muted); }
  .output {
    flex: 1;
    min-height: 120px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-raised);
    padding: 10px;
    overflow: auto;
    font-size: 12.5px;
  }
  /* A merged team deliverable sits under the parts list: keep it readable. */
  .output.merged { min-height: 220px; }
  .output.streaming { border-color: rgb(120 200 255 / 0.6); }
  .output pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 1.45; }
  .err { margin: 0; font-size: 12px; color: var(--color-danger); white-space: pre-wrap; }
  .actions { display: flex; gap: 8px; }
</style>
