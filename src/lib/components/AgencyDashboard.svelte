<script lang="ts">
  /**
   * Agency Dashboard: the agency at a glance. What is being worked on right
   * now, what was delivered, who is busiest and what it cost; then the catalog
   * and install report, folded away underneath.
   *
   * This file loads the data and lays the page out. Each block lives in
   * `dashboard/`.
   */
  import { errorText } from "$lib/types";
  import { onMount } from "svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import RepoIcon from "@lucide/svelte/icons/git-branch";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { projects } from "$lib/stores/projects.svelte";
  import { catalog } from "$lib/stores/catalog.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { toast } from "$lib/stores/toast.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { dailySeries, daysAgo, perAgent, perDepartment, recentFinished } from "$lib/office/stats";
  import type { AgentLoad } from "$lib/office/stats";
  import Button from "./Button.svelte";
  import EmptyState from "./EmptyState.svelte";
  import ActivityBars from "./dashboard/ActivityBars.svelte";
  import BarList from "./dashboard/BarList.svelte";
  import type { BarItem } from "./dashboard/BarList.svelte";
  import CatalogHealth from "./dashboard/CatalogHealth.svelte";
  import DashCard from "./dashboard/DashCard.svelte";
  import InFlightList from "./dashboard/InFlightList.svelte";
  import OpsHero from "./dashboard/OpsHero.svelte";
  import RecentDeliverables from "./dashboard/RecentDeliverables.svelte";
  import TopAgents from "./dashboard/TopAgents.svelte";

  // Install state is loaded globally in +layout; the rest is read here.
  onMount(() => {
    corpus.ensureLoaded();
    projects.refresh();
    // Local-only reads (no network): learn whether the active catalog is a
    // git clone we maintain, so the "Update from GitHub" control can appear.
    void catalog.load().then(() => catalog.loadStatus());
    // Task history and live task events. Safe to call from every view.
    void office.start();
  });

  // ── "Update from GitHub" — only when the active catalog is a git clone we're
  //    allowed to pull (managed clone, or a user clone with manage permission).
  //    Bundled/snapshot and read-only clones show nothing. ──
  const catalogReadOnly = $derived(
    catalog.source.kind === "userClone" && !catalog.source.manage,
  );
  const showCatalogUpdate = $derived(!!catalog.status?.isGit && !catalogReadOnly);
  const catalogRepo = $derived(catalog.status?.repoSlug ?? null);

  async function updateCatalog() {
    if (catalog.busy) return;
    try {
      await catalog.pull();
      toast.success(i18n.t("dashboard.catalogUpdated"));
    } catch (e) {
      toast.error(i18n.t("common.actionFailed"), errorText(e));
    }
  }

  // ── Operations. Figures move with the minute, not the second: only the
  //    in-flight timers read the per-second clock. ──
  const minuteNow = $derived(Math.floor(office.now / 60_000) * 60_000);
  const weekStart = $derived(daysAgo(minuteNow, 6));

  const recent = $derived(recentFinished(office.tasks, 8));
  const activity = $derived(dailySeries(office.tasks, 14, minuteNow));
  const topAgents = $derived(perAgent(office.tasks, weekStart).slice(0, 5));
  const departmentBars = $derived<BarItem[]>(
    perDepartment(office.tasks, weekStart)
      .slice(0, 6)
      .map((d) => ({
        key: d.slug,
        label: corpus.labelOf(d.slug),
        value: d.count,
        dot: corpus.colorOf(d.slug),
        onClick: () => ui.openDivision(d.slug),
      })),
  );

  let hero: OpsHero | undefined = $state();

  /** Show a task where its stream and deliverable can be read: the Office. */
  function openTask(taskId: string) {
    office.selectedTask = taskId;
    office.selectedAgent = null;
    ui.setSection("office");
  }
  function openAgent(a: AgentLoad) {
    ui.openAgents(a.department);
    ui.selectAgent(a.slug);
  }
</script>

<section class="dash">
  {#if showCatalogUpdate}
    <div class="cat-bar">
      <span class="cat-info">
        <RepoIcon size={15} />
        <span class="cat-repo">{catalogRepo ?? i18n.t("dashboard.catalogGitHub")}</span>
        {#if catalog.updateCheck && !catalog.updateCheck.upToDate && catalog.updateCheck.behind > 0}
          <span class="cat-behind">{i18n.t("dashboard.catalogBehind", { count: catalog.updateCheck.behind })}</span>
        {/if}
      </span>
      <button
        class="cat-btn"
        disabled={catalog.busy}
        onclick={updateCatalog}
        title={catalogRepo ? i18n.t("dashboard.catalogManagedFrom", { repo: catalogRepo }) : undefined}
      >
        <RefreshCw size={14} class={catalog.busy ? "cat-spin" : ""} />
        <span>{catalog.busy ? i18n.t("common.working") : i18n.t("dashboard.updateFromGitHub")}</span>
      </button>
    </div>
  {/if}

  <OpsHero bind:this={hero} now={minuteNow} />

  {#if office.historyLoaded && office.tasks.length === 0}
    <div class="quiet">
      <EmptyState title={i18n.t("dashboard.ops.quietTitle")} body={i18n.t("dashboard.ops.quietBody")}>
        {#snippet cta()}
          <Button variant="primary" onclick={() => hero?.focusComposer()}>{i18n.t("dashboard.ops.firstTask")}</Button>
          <Button variant="secondary" onclick={() => ui.setSection("office")}>{i18n.t("dashboard.ops.openOffice")}</Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if office.historyLoaded}
    <div class="ops">
      <div class="col">
        <DashCard title={i18n.t("dashboard.ops.inFlight")} sub={office.running.length > 0 ? String(office.running.length) : undefined}>
          <InFlightList onOpen={openTask} />
        </DashCard>
        <DashCard title={i18n.t("dashboard.ops.recent")}>
          {#snippet action()}
            <button class="link" onclick={() => ui.setSection("office")}>{i18n.t("dashboard.ops.openOffice")}</button>
          {/snippet}
          <RecentDeliverables tasks={recent} now={minuteNow} onOpen={openTask} />
        </DashCard>
      </div>
      <div class="col">
        <DashCard title={i18n.t("dashboard.ops.activity")} sub={i18n.t("dashboard.ops.last14")}>
          <ActivityBars points={activity} />
        </DashCard>
        <DashCard title={i18n.t("dashboard.ops.busiest")} sub={i18n.t("dashboard.ops.last7")}>
          {#if departmentBars.length === 0}
            <p class="muted">{i18n.t("dashboard.ops.noneYet")}</p>
          {:else}
            <BarList items={departmentBars} />
          {/if}
        </DashCard>
        <DashCard title={i18n.t("dashboard.ops.topAgents")} sub={i18n.t("dashboard.ops.last7")}>
          <TopAgents agents={topAgents} onOpen={openAgent} />
        </DashCard>
      </div>
    </div>
  {/if}

  <CatalogHealth />
</section>

<style>
  .dash { height: 100%; overflow-y: auto; padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
  /* Children keep their own height: the page scrolls, the cards never squash. */
  .dash > :global(*) { flex: none; }

  /* ── "Update from GitHub" bar (only when the catalog is a managed git clone) ── */
  .cat-bar {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border); border-radius: var(--radius-md);
    background: var(--color-surface-raised);
  }
  .cat-info { display: flex; align-items: center; gap: var(--space-2); min-width: 0; color: var(--color-text-secondary); font-size: var(--text-body-sm); }
  .cat-repo { font-family: var(--font-mono, ui-monospace, monospace); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cat-behind { flex: none; font-size: var(--text-caption); font-weight: var(--fw-semibold); color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 15%, transparent); padding: 1px 7px; border-radius: var(--radius-full); }
  .cat-btn {
    display: inline-flex; align-items: center; gap: 6px; flex: none;
    height: 30px; padding: 0 var(--space-3);
    border: 1px solid transparent; border-radius: var(--radius-md);
    background: var(--color-brand); color: var(--color-text-inverse);
    font-size: var(--text-body-sm); cursor: pointer;
  }
  .cat-btn:hover:not(:disabled) { filter: brightness(1.08); }
  .cat-btn:disabled { opacity: 0.6; cursor: default; }
  :global(.cat-spin) { animation: cat-spin 0.7s linear infinite; }
  @keyframes cat-spin { to { transform: rotate(360deg); } }

  /* ── Operations: work on the left, figures on the right ── */
  .ops { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  @media (max-width: 820px) { .ops { grid-template-columns: minmax(0, 1fr); } }

  .quiet {
    border: 1px dashed var(--color-border-strong); border-radius: var(--radius-lg);
    padding: var(--space-4) 0;
  }
  .muted { color: var(--color-text-muted); font-size: var(--text-body-sm); }
  .link { background: transparent; color: var(--color-brand); font-size: var(--text-body-sm); cursor: pointer; padding: 0; }
  .link:hover { text-decoration: underline; }
</style>
