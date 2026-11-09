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
  import { invoke } from "@tauri-apps/api/core";

  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { AGENCY_NAME } from "$lib/util/brand";
  import { errorText, type Agent, type OfficeTask } from "$lib/types";
  import type { SceneDepartment } from "$lib/office/scene";

  import OfficeCanvas from "./OfficeCanvas.svelte";
  import Button from "./Button.svelte";
  import Pill from "./Pill.svelte";

  import Send from "@lucide/svelte/icons/send";
  import Square from "@lucide/svelte/icons/square";
  import Maximize from "@lucide/svelte/icons/maximize";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import Wrench from "@lucide/svelte/icons/wrench";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  let canvasRef: OfficeCanvas | undefined = $state();
  let sending = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();

  onMount(() => {
    void corpus.ensureLoaded();
    void office.start();
  });

  // ---------- Roster → scene ----------
  const departments: SceneDepartment[] = $derived.by(() => {
    const byCat = new Map<string, Agent[]>();
    for (const a of corpus.agents) {
      const list = byCat.get(a.category) ?? [];
      list.push(a);
      byCat.set(a.category, list);
    }
    return [...byCat.entries()].map(([slug, agents]) => ({
      slug,
      label: corpus.labelOf(slug),
      color: corpus.colorOf(slug),
      agents: agents.map((a) => ({ slug: a.slug, name: a.name, emoji: a.emoji })),
    }));
  });

  const agentsInDept = $derived(
    office.composerDepartment ? corpus.agents.filter((a) => a.category === office.composerDepartment) : corpus.agents,
  );

  const selectedAgent: Agent | null = $derived(
    office.selectedAgent ? (corpus.agents.find((a) => a.slug === office.selectedAgent) ?? null) : null,
  );
  const selectedTask: OfficeTask | null = $derived(
    office.selectedTask ? (office.tasks.find((t) => t.id === office.selectedTask) ?? null) : null,
  );

  /** Who the composer would send to right now (local guess until sent). */
  const routedAgent: Agent | null = $derived.by(() => {
    if (office.composerAgent) return corpus.agents.find((a) => a.slug === office.composerAgent) ?? null;
    if (!office.draft.trim()) return null;
    return office.guess(office.draft, corpus.agents, office.composerDepartment);
  });
  const autoRouting = $derived(!office.composerAgent);

  const runnerReady = $derived(office.runner?.available === true && office.runner?.loggedIn !== false);
  const canSend = $derived(!!office.draft.trim() && !!routedAgent && !sending && runnerReady);
  let routing = $state(false);

  // ---------- Picks from the floor ----------
  function pickAgent(slug: string) {
    office.selectedAgent = slug;
    office.selectedTask = null;
    const a = corpus.agents.find((x) => x.slug === slug);
    if (a) {
      office.composerDepartment = a.category;
      office.composerAgent = a.slug;
    }
  }
  function pickPod(slug: string) {
    office.selectedAgent = null;
    office.selectedTask = null;
    office.composerDepartment = slug;
    office.composerAgent = null;
    canvasRef?.focusPod(slug);
  }
  function pickNothing() {
    office.selectedAgent = null;
    office.selectedTask = null;
  }

  function onDeptChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerDepartment = v || null;
    office.composerAgent = null;
  }
  function onAgentChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerAgent = v || null;
  }

  // ---------- Dispatch ----------
  async function send() {
    let agent = routedAgent;
    const prompt = office.draft.trim();
    if (!agent || !prompt || sending) return;
    sending = true;
    try {
      if (autoRouting) {
        routing = true;
        agent = (await office.route(prompt, corpus.agents, office.composerDepartment)) ?? agent;
        routing = false;
      }
      const task = await office.dispatch(agent.slug, prompt, AGENCY_NAME);
      office.draft = "";
      office.selectedTask = task.id;
      office.selectedAgent = null;
      toast.info(i18n.t("office.toast.sent", { agent: agent.name }));
    } catch (err) {
      toast.error(i18n.t("office.toast.failed"), errorText(err));
    } finally {
      sending = false;
      routing = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  }

  async function reveal(path: string) {
    try {
      await invoke("reveal_path", { path });
    } catch (err) {
      toast.error(i18n.t("office.toast.revealFailed"), errorText(err));
    }
  }

  // ---------- Presentation helpers ----------
  function elapsed(t: OfficeTask): string {
    const end = t.finishedAt ? Date.parse(t.finishedAt) : office.now;
    const s = Math.max(0, Math.round((end - Date.parse(t.startedAt)) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
  function tone(t: OfficeTask): "info" | "success" | "danger" | "neutral" {
    if (t.status === "running") return "info";
    if (t.status === "done") return "success";
    if (t.status === "error") return "danger";
    return "neutral";
  }
  function statusLabel(t: OfficeTask): string {
    return i18n.t(`office.status.${t.status}` as Parameters<typeof i18n.t>[0]);
  }
  function emojiOf(slug: string): string {
    return corpus.agents.find((a) => a.slug === slug)?.emoji ?? "";
  }
  function cost(t: OfficeTask): string | null {
    if (t.costUsd == null) return null;
    return t.costUsd < 0.01 ? "<$0.01" : `$${t.costUsd.toFixed(2)}`;
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
    <div class="runner" class:ok={runnerReady} class:missing={office.runnerChecked && !runnerReady}>
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

    <!-- Composer -->
    <section class="composer">
      <div class="row">
        <select class="sel" value={office.composerDepartment ?? ""} onchange={onDeptChange} aria-label={i18n.t("office.department")}>
          <option value="">{i18n.t("office.anyDepartment")}</option>
          {#each departments as d (d.slug)}
            <option value={d.slug}>{d.label}</option>
          {/each}
        </select>
        <select class="sel" value={office.composerAgent ?? ""} onchange={onAgentChange} aria-label={i18n.t("office.agent")}>
          <option value="">{i18n.t("office.pickForMe")}</option>
          {#each agentsInDept as a (a.slug)}
            <option value={a.slug}>{a.emoji ? `${a.emoji} ` : ""}{a.name}</option>
          {/each}
        </select>
      </div>
      <textarea
        bind:this={textarea}
        bind:value={office.draft}
        rows="3"
        placeholder={i18n.t("office.placeholder")}
        onkeydown={onKey}
      ></textarea>
      <div class="row send-row">
        <span class="routed">
          {#if routing}
            {i18n.t("office.routing")}
          {:else if routedAgent}
            {autoRouting ? i18n.t("office.probablyGoesTo") : i18n.t("office.goesTo")} <strong>{routedAgent.emoji ? `${routedAgent.emoji} ` : ""}{routedAgent.name}</strong>
          {:else}
            {i18n.t("office.goesToHint")}
          {/if}
        </span>
        <Button variant="primary" size="sm" disabled={!canSend} loading={sending} onclick={send} title={autoRouting ? i18n.t("office.sendTitleAuto") : i18n.t("office.sendTitle")}>
          <Send size={14} /> {i18n.t("office.send")}
        </Button>
      </div>
    </section>

    <!-- Detail or feed -->
    {#if selectedTask}
      {@const t = selectedTask}
      <section class="detail">
        <button class="back" onclick={() => (office.selectedTask = null)}><ChevronLeft size={14} /> {i18n.t("office.backToFeed")}</button>
        <header class="detail-head">
          <div class="who">{emojiOf(t.agentSlug)} <strong>{t.agentName}</strong> <span class="muted">· {corpus.labelOf(t.department)}</span></div>
          <div class="meta">
            <Pill tone={tone(t)}>{statusLabel(t)}</Pill>
            <span class="muted">{elapsed(t)}</span>
            {#if t.numTurns != null}<span class="muted">· {i18n.t("office.turns", { count: t.numTurns })}</span>{/if}
            {#if cost(t)}<span class="muted">· {cost(t)}</span>{/if}
          </div>
        </header>
        <p class="prompt">{t.prompt}</p>
        {#if t.toolsUsed.length > 0}
          <div class="tools"><Wrench size={12} /> {t.toolsUsed.join(", ")}</div>
        {/if}
        <div class="output" class:streaming={t.status === "running"}>
          {#if t.output}
            <pre>{t.output}</pre>
          {:else if t.status === "running"}
            <span class="muted">{i18n.t("office.thinking")}</span>
          {/if}
          {#if t.error}<p class="err">{t.error}</p>{/if}
        </div>
        <div class="actions">
          {#if t.status === "running"}
            <Button variant="danger" size="sm" onclick={() => office.cancel(t.id)}><Square size={12} /> {i18n.t("office.stop")}</Button>
          {/if}
          {#if t.deliverablePath}
            <Button variant="secondary" size="sm" onclick={() => reveal(t.deliverablePath!)}><FolderOpen size={12} /> {i18n.t("office.reveal")}</Button>
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
                <span class="fi-top"><Pill tone={tone(t)}>{statusLabel(t)}</Pill><span class="muted">{elapsed(t)}</span></span>
                <span class="fi-prompt">{t.prompt}</span>
              </button></li>
            {/each}
          </ul>
        {/if}
      </section>
    {:else}
      <section class="feedwrap">
        <h3 class="sub">{i18n.t("office.feed")} {#if office.running.length}<span class="live">{i18n.t("office.live", { count: office.running.length })}</span>{/if}</h3>
        {#if office.feed.length === 0}
          <p class="muted empty">{i18n.t("office.feedEmpty")}</p>
        {:else}
          <ul class="feed">
            {#each office.feed as t (t.id)}
              <li><button class="feed-item" onclick={() => (office.selectedTask = t.id)}>
                <span class="fi-top">
                  <span class="fi-who">{emojiOf(t.agentSlug)} {t.agentName}</span>
                  <Pill tone={tone(t)}>{statusLabel(t)}</Pill>
                </span>
                <span class="fi-prompt">{t.prompt}</span>
                <span class="fi-meta muted">{corpus.labelOf(t.department)} · {elapsed(t)}{#if t.toolsUsed.length} · {t.toolsUsed.length} {i18n.t("office.toolsShort")}{/if}</span>
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

  .composer {
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row { display: flex; gap: 8px; align-items: center; }
  .sel {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 12px;
    padding: 5px 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
  }
  textarea {
    width: 100%;
    resize: vertical;
    min-height: 64px;
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    padding: 8px 10px;
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
  }
  textarea:focus { outline: none; border-color: var(--color-border-focus); box-shadow: var(--shadow-focus-ring); }
  .send-row { justify-content: space-between; }
  .routed { font-size: 11.5px; color: var(--color-text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .routed strong { color: var(--color-text-primary); font-weight: 600; }

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
  .fi-meta { font-size: 11px; }
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
  .output.streaming { border-color: rgb(120 200 255 / 0.6); }
  .output pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; line-height: 1.45; }
  .err { margin: 0; font-size: 12px; color: var(--color-danger); white-space: pre-wrap; }
  .actions { display: flex; gap: 8px; }
</style>
