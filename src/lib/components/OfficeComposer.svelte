<script lang="ts">
  /**
   * The task box: pick a department and an agent (or let the office route
   * it), type what needs doing, send. Used in the Office side panel and, in
   * `compact` form, in the dashboard hero.
   *
   * The draft and the picks live in the `office` store, so a half-typed
   * task follows you from one to the other.
   */
  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { AGENCY_NAME } from "$lib/util/brand";
  import { errorText, type Agent, type OfficeTask } from "$lib/types";
  import Button from "./Button.svelte";
  import Send from "@lucide/svelte/icons/send";

  interface Props {
    /** Tighter layout with no chrome of its own, for embedding in a card. */
    compact?: boolean;
    /** Called once the task is running. */
    onSent?: (task: OfficeTask) => void;
  }
  let { compact = false, onSent }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let sending = $state(false);
  let routing = $state(false);

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

  /** Who the composer would send to right now (local guess until sent). */
  const routedAgent: Agent | null = $derived.by(() => {
    if (office.composerAgent) return corpus.agents.find((a) => a.slug === office.composerAgent) ?? null;
    if (!office.draft.trim()) return null;
    return office.guess(office.draft, corpus.agents, office.composerDepartment);
  });
  const autoRouting = $derived(!office.composerAgent);
  const canSend = $derived(!!office.draft.trim() && !!routedAgent && !sending && office.runnerReady);
  const runnerDown = $derived(office.runnerChecked && !office.runnerReady);

  function onDeptChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerDepartment = v || null;
    office.composerAgent = null;
  }
  function onAgentChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    office.composerAgent = v || null;
  }

  async function send() {
    let agent = routedAgent;
    const prompt = office.draft.trim();
    if (!agent || !prompt || sending || !office.runnerReady) return;
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
      onSent?.(task);
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
    rows={compact ? 2 : 3}
    placeholder={i18n.t("office.placeholder")}
    onkeydown={onKey}
  ></textarea>
  <div class="row send-row">
    <span class="routed" class:warn={compact && runnerDown}>
      {#if compact && runnerDown}
        {office.runner?.available ? i18n.t("office.runner.signedOut") : i18n.t("office.runner.missing")}
      {:else if routing}
        {i18n.t("office.routing")}
      {:else if routedAgent}
        {autoRouting ? i18n.t("office.probablyGoesTo") : i18n.t("office.goesTo")}
        <strong>{routedAgent.emoji ? `${routedAgent.emoji} ` : ""}{routedAgent.name}</strong>
      {:else}
        {i18n.t("office.goesToHint")}
      {/if}
    </span>
    <Button
      variant="primary"
      size="sm"
      disabled={!canSend}
      loading={sending}
      onclick={send}
      title={autoRouting ? i18n.t("office.sendTitleAuto") : i18n.t("office.sendTitle")}
    >
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
  .routed { font-size: 11.5px; color: var(--color-text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .routed strong { color: var(--color-text-primary); font-weight: 600; }
  .routed.warn { color: var(--color-warning-strong); white-space: normal; }
</style>
