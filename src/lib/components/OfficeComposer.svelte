<script lang="ts">
  /**
   * The task box: pick a department and an agent (or let the office route
   * it), type what needs doing, send. Used in the Office side panel and, in
   * `compact` form, in the dashboard hero.
   *
   * Two ways to hand a task out. Solo: one agent takes it. Team: a lead
   * splits it across a team, the members work their parts side by side, and
   * the lead merges them into one deliverable.
   *
   * The draft and the picks live in the `office` store, so a half-typed
   * task follows you from one to the other.
   */
  import { onMount } from "svelte";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { teams } from "$lib/stores/teams.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { PRESET_TEAMS } from "$lib/data/presetTeams";
  import type { MessageKey } from "$lib/i18n/messages";
  import { AGENCY_NAME } from "$lib/util/brand";
  import { errorText, type Agent, type OfficeTask } from "$lib/types";
  import Button from "./Button.svelte";
  import Send from "@lucide/svelte/icons/send";
  import User from "@lucide/svelte/icons/user";
  import Users from "@lucide/svelte/icons/users";

  interface Props {
    /** Tighter layout with no chrome of its own, for embedding in a card. */
    compact?: boolean;
    /** Called once the task is running. */
    onSent?: (task: OfficeTask) => void;
  }
  let { compact = false, onSent }: Props = $props();

  /** The most members the lead may be given a part for (`office::team::MAX_MEMBERS`). */
  const MAX_MEMBERS = 5;

  let textarea: HTMLTextAreaElement | undefined = $state();
  let sending = $state(false);
  let routing = $state(false);

  onMount(() => teams.hydrate());

  const teamMode = $derived(office.composerMode === "team");
  const bySlug = $derived(new Map(corpus.agents.map((a) => [a.slug, a])));

  /** Departments in catalog order. */
  const departments = $derived.by(() => {
    const seen = new Set<string>();
    const out: { slug: string; label: string }[] = [];
    for (const a of corpus.agents) {
      if (seen.has(a.category)) continue;
      seen.add(a.category);
      out.push({ slug: a.category, label: corpus.labelOf(a.category) });
    }
    return out;
  });

  const agentsInDept = $derived(
    office.composerDepartment ? corpus.agents.filter((a) => a.category === office.composerDepartment) : corpus.agents,
  );

  // ---------- Solo ----------

  /** Who the composer would send to right now (local guess until sent). */
  const routedAgent: Agent | null = $derived.by(() => {
    if (office.composerAgent) return bySlug.get(office.composerAgent) ?? null;
    if (!office.draft.trim()) return null;
    return office.guess(office.draft, corpus.agents, office.composerDepartment);
  });
  const autoRouting = $derived(!office.composerAgent);

  // ---------- Team ----------

  interface TeamChoice {
    key: string;
    label: string;
    /** The team's agents that this catalog has. */
    agents: Agent[];
  }

  const known = (slugs: string[]): Agent[] => slugs.map((s) => bySlug.get(s)).filter((a): a is Agent => !!a);

  /** Ready-made teams with enough of their agents in this catalog to be a team. */
  const presetChoices = $derived<TeamChoice[]>(
    PRESET_TEAMS.map((p) => ({
      key: `preset:${p.slug}`,
      label: i18n.t(`preset.${p.slug}.label` as MessageKey),
      agents: known(p.agents),
    })).filter((c) => c.agents.length >= 2),
  );
  const savedChoices = $derived<TeamChoice[]>(
    teams.saved
      .map((t) => ({ key: `saved:${t.id}`, label: t.name, agents: known(t.agents) }))
      .filter((c) => c.agents.length >= 2),
  );

  /** The team picked in the members list; `null` = the lead picks from a department. */
  const fixedTeam = $derived(
    office.composerTeam ? ([...presetChoices, ...savedChoices].find((c) => c.key === office.composerTeam) ?? null) : null,
  );

  /** Who may lead: someone on the picked team, else someone in the department. */
  const leadOptions = $derived(fixedTeam ? fixedTeam.agents : agentsInDept);
  const pickedLead = $derived(leadOptions.find((a) => a.slug === office.composerLead) ?? null);
  const autoLead = $derived(!pickedLead);

  /** Who would lead right now (local guess until sent). */
  const lead: Agent | null = $derived.by(() => {
    if (pickedLead) return pickedLead;
    if (!office.draft.trim()) return null;
    return fixedTeam
      ? office.guess(office.draft, fixedTeam.agents, null)
      : office.guess(office.draft, corpus.agents, office.composerDepartment);
  });

  /** "picks 2 to 5 from Engineering", "with 3 from Mobile Launch". */
  const teamSuffix = $derived.by(() => {
    if (!lead) return "";
    if (!fixedTeam) return i18n.t("office.teamPicks", { department: corpus.labelOf(lead.category) });
    const others = fixedTeam.agents.filter((a) => a.slug !== lead.slug).length;
    return others > MAX_MEMBERS
      ? i18n.t("office.teamPool", { team: fixedTeam.label })
      : i18n.t("office.teamFixed", { count: others, team: fixedTeam.label });
  });

  // ---------- Sending ----------

  const target = $derived(teamMode ? lead : routedAgent);
  const canSend = $derived(!!office.draft.trim() && !!target && !sending && office.runnerReady);
  const runnerDown = $derived(office.runnerChecked && !office.runnerReady);
  const sendTitle = $derived(
    teamMode
      ? i18n.t("office.sendTitleTeam")
      : autoRouting
        ? i18n.t("office.sendTitleAuto")
        : i18n.t("office.sendTitle"),
  );

  function onDeptChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerDepartment = v || null;
    office.composerAgent = null;
    office.composerLead = null;
  }
  function onAgentChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerAgent = v || null;
  }
  function onLeadChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerLead = v || null;
  }
  function onTeamChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerTeam = v || null;
  }

  async function sendSolo(prompt: string): Promise<{ task: OfficeTask; note: string } | null> {
    let agent = routedAgent;
    if (!agent) return null;
    if (autoRouting) {
      routing = true;
      agent = (await office.route(prompt, corpus.agents, office.composerDepartment)) ?? agent;
      routing = false;
    }
    const task = await office.dispatch(agent.slug, prompt, AGENCY_NAME);
    return { task, note: i18n.t("office.toast.sent", { agent: agent.name }) };
  }

  async function sendTeam(prompt: string): Promise<{ task: OfficeTask; note: string } | null> {
    let who = lead;
    if (!who) return null;
    const team = fixedTeam;
    if (autoLead) {
      routing = true;
      who =
        (team
          ? await office.route(prompt, team.agents, null)
          : await office.route(prompt, corpus.agents, office.composerDepartment)) ?? who;
      routing = false;
    }
    const leadSlug = who.slug;
    let members: string[] = [];
    let candidates: string[] = [];
    if (team) {
      members = team.agents.filter((a) => a.slug !== leadSlug).map((a) => a.slug);
    } else {
      // The lead's own department, or the whole office when that leaves
      // too few people to make a team of.
      const dept = corpus.agents.filter((a) => a.category === who.category && a.slug !== leadSlug);
      const pool = dept.length >= 2 ? dept : corpus.agents.filter((a) => a.slug !== leadSlug);
      candidates = pool.map((a) => a.slug);
    }
    if (members.length === 0 && candidates.length === 0) throw new Error(i18n.t("office.teamTooSmall"));
    const task = await office.dispatchTeam(leadSlug, members, candidates, prompt, AGENCY_NAME);
    return { task, note: i18n.t("office.toast.teamSent", { agent: who.name }) };
  }

  async function send() {
    const prompt = office.draft.trim();
    if (!target || !prompt || sending || !office.runnerReady) return;
    sending = true;
    try {
      const sent = teamMode ? await sendTeam(prompt) : await sendSolo(prompt);
      if (!sent) return;
      office.draft = "";
      office.selectedTask = sent.task.id;
      office.selectedAgent = null;
      toast.info(sent.note);
      onSent?.(sent.task);
    } catch (err) {
      toast.error(i18n.t("office.toast.failed"), errorText(err));
    } finally {
      sending = false;
      routing = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  /** Put the caret in the task box. */
  export function focus() {
    textarea?.focus();
  }
</script>

<section class="composer" class:compact>
  <div class="mode" role="group" aria-label={i18n.t("office.mode")}>
    <button
      type="button"
      class="seg"
      class:on={!teamMode}
      aria-pressed={!teamMode}
      title={i18n.t("office.mode.soloTitle")}
      onclick={() => (office.composerMode = "solo")}
    >
      <User size={13} />{i18n.t("office.mode.solo")}
    </button>
    <button
      type="button"
      class="seg"
      class:on={teamMode}
      aria-pressed={teamMode}
      title={i18n.t("office.mode.teamTitle")}
      onclick={() => (office.composerMode = "team")}
    >
      <Users size={13} />{i18n.t("office.mode.team")}
    </button>
  </div>

  {#if teamMode}
    <div class="row">
      <select class="sel" value={fixedTeam?.key ?? ""} onchange={onTeamChange} aria-label={i18n.t("office.members")}>
        <option value="">{i18n.t("office.pickMembers")}</option>
        {#if presetChoices.length > 0}
          <optgroup label={i18n.t("office.presetTeams")}>
            {#each presetChoices as c (c.key)}
              <option value={c.key}>{i18n.t("office.teamOption", { name: c.label, count: c.agents.length })}</option>
            {/each}
          </optgroup>
        {/if}
        {#if savedChoices.length > 0}
          <optgroup label={i18n.t("office.savedTeams")}>
            {#each savedChoices as c (c.key)}
              <option value={c.key}>{i18n.t("office.teamOption", { name: c.label, count: c.agents.length })}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </div>
    <div class="row">
      {#if !fixedTeam}
        <select class="sel" value={office.composerDepartment ?? ""} onchange={onDeptChange} aria-label={i18n.t("office.department")}>
          <option value="">{i18n.t("office.anyDepartment")}</option>
          {#each departments as d (d.slug)}
            <option value={d.slug}>{d.label}</option>
          {/each}
        </select>
      {/if}
      <select class="sel" value={pickedLead?.slug ?? ""} onchange={onLeadChange} aria-label={i18n.t("office.lead")}>
        <option value="">{i18n.t("office.pickLead")}</option>
        {#each leadOptions as a (a.slug)}
          <option value={a.slug}>{a.emoji ? `${a.emoji} ` : ""}{a.name}</option>
        {/each}
      </select>
    </div>
  {:else}
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
  {/if}

  <textarea
    bind:this={textarea}
    bind:value={office.draft}
    rows={compact ? 2 : 3}
    placeholder={i18n.t("office.placeholder")}
    onkeydown={onKey}
  ></textarea>
  <div class="row send-row">
    <span class="routed" class:warn={compact && runnerDown} class:wrap={teamMode}>
      {#if compact && runnerDown}
        {office.runner?.available ? i18n.t("office.runner.signedOut") : i18n.t("office.runner.missing")}
      {:else if routing}
        {i18n.t("office.routing")}
      {:else if teamMode}
        {#if lead}
          {autoLead ? i18n.t("office.probablyLedBy") : i18n.t("office.ledBy")}
          <strong>{lead.emoji ? `${lead.emoji} ` : ""}{lead.name}</strong>
          · {teamSuffix}
        {:else}
          {i18n.t("office.teamHint")}
        {/if}
      {:else if routedAgent}
        {autoRouting ? i18n.t("office.probablyGoesTo") : i18n.t("office.goesTo")}
        <strong>{routedAgent.emoji ? `${routedAgent.emoji} ` : ""}{routedAgent.name}</strong>
      {:else}
        {i18n.t("office.goesToHint")}
      {/if}
    </span>
    <Button variant="primary" size="sm" disabled={!canSend} loading={sending} onclick={send} title={sendTitle}>
      {#snippet icon()}<Send size={14} />{/snippet}
      {i18n.t("office.send")}
    </Button>
  </div>
</section>

<style>
  .composer {
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .composer.compact { padding: 0; border-bottom: 0; }
  .row { display: flex; gap: 8px; align-items: center; }

  /* Solo | Team: a two-way switch, the chosen side raised. */
  .mode {
    align-self: flex-start;
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border-radius: 8px;
    background: var(--color-surface-sunken);
    border: 1px solid var(--color-border);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
    font-weight: var(--fw-medium);
    color: var(--color-text-secondary);
    background: transparent;
    cursor: pointer;
  }
  .seg:hover { color: var(--color-text-primary); }
  .seg.on {
    background: var(--color-surface-raised);
    color: var(--color-text-primary);
    box-shadow: var(--shadow-xs);
  }
  .seg:focus-visible { outline: none; box-shadow: var(--shadow-focus-ring); }

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
  .compact textarea { min-height: 52px; resize: none; }
  textarea:focus { outline: none; border-color: var(--color-border-focus); box-shadow: var(--shadow-focus-ring); }
  .send-row { justify-content: space-between; }
  /* The hint may wrap to two lines; the button keeps its own width. */
  .send-row :global(.btn) { flex: none; }
  .routed { font-size: 11.5px; color: var(--color-text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .routed strong { color: var(--color-text-primary); font-weight: 600; }
  .routed.warn { color: var(--color-warning-strong); white-space: normal; }
  /* A team line names the lead and the team: let it take a second line. */
  .routed.wrap {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
