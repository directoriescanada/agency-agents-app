<script lang="ts">
  /**
   * The top of the dashboard: who the agency is, what it is doing right now,
   * a task box, and a live window onto the office floor.
   *
   * The window is the real office canvas with the controls taken away: it
   * frames whoever is working (or the whole floor) and a click walks in.
   */
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { corpus } from "$lib/stores/corpus.svelte";
  import { office } from "$lib/stores/office.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import { i18n } from "$lib/stores/i18n.svelte";
  import { AGENCY_NAME } from "$lib/util/brand";
  import { buildDepartments } from "$lib/office/scene";
  import { daysAgo, doneToday, spendBetween, startOfDay, tasksToday } from "$lib/office/stats";
  import { formatCost } from "$lib/office/format";
  import BrandMark from "../BrandMark.svelte";
  import InfoButton from "../InfoButton.svelte";
  import OfficeCanvas from "../OfficeCanvas.svelte";
  import OfficeComposer from "../OfficeComposer.svelte";

  interface Props {
    /** The clock the figures are counted against, in ms. Minute steps are plenty. */
    now: number;
  }
  let { now }: Props = $props();

  let composer: OfficeComposer | undefined = $state();

  /** Put the caret in the task box. */
  export function focusComposer() {
    composer?.focus();
  }

  const departments = $derived(
    buildDepartments(
      corpus.agents,
      (slug) => corpus.labelOf(slug),
      (slug) => corpus.colorOf(slug),
    ),
  );

  const working = $derived(office.running.length);
  const today = $derived(tasksToday(office.tasks, now));
  const done = $derived(doneToday(office.tasks, now));
  const costToday = $derived(spendBetween(office.tasks, startOfDay(now), Infinity));
  const costWeek = $derived(spendBetween(office.tasks, daysAgo(now, 6), Infinity));
</script>

<section class="hero">
  <div class="main">
    <header class="id">
      <BrandMark size={36} />
      <div class="names">
        <h2 class="name">{AGENCY_NAME}</h2>
        <p class="tagline">
          {i18n.t("dashboard.ops.subtitle", { agents: corpus.agents.length, departments: departments.length })}
        </p>
      </div>
    </header>

    <div class="stats">
      <div class="stat">
        <span class="num">
          {#if working > 0}<span class="live" aria-hidden="true"></span>{/if}{working}
        </span>
        <span class="lbl">{i18n.t("dashboard.ops.workingNow")}</span>
      </div>
      <div class="stat">
        <span class="num">{today}</span>
        <span class="lbl">{i18n.t("dashboard.ops.tasksToday")}</span>
      </div>
      <div class="stat">
        <span class="num">{done}</span>
        <span class="lbl">{i18n.t("dashboard.ops.doneToday")}</span>
      </div>
      <div class="stat">
        <span class="num">{formatCost(costToday)}</span>
        <span class="lbl">
          {i18n.t("dashboard.ops.costToday")}
          <InfoButton
            title={i18n.t("dashboard.ops.costTitle")}
            body={i18n.t("dashboard.ops.costHint")}
            label={i18n.t("dashboard.ops.costTitle")}
          />
        </span>
        <span class="sub">{i18n.t("dashboard.ops.costWeek", { amount: formatCost(costWeek) ?? "" })}</span>
      </div>
    </div>

    <OfficeComposer compact bind:this={composer} />
  </div>

  <div class="art">
    <div class="floor">
      <OfficeCanvas
        interactive={false}
        {departments}
        agencyName={AGENCY_NAME}
        onEnter={() => ui.setSection("office")}
        enterLabel={i18n.t("dashboard.ops.miniOfficeLabel")}
      />
    </div>
    <span class="enter" aria-hidden="true">{i18n.t("dashboard.ops.openOffice")} <ArrowRight size={13} /></span>
  </div>
</section>

<style>
  .hero {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
    border: 1px solid var(--color-border); border-radius: var(--radius-lg);
    background: var(--color-surface-raised); overflow: hidden;
  }
  .main { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5); min-width: 0; }

  .id { display: flex; align-items: center; gap: var(--space-3); }
  .names { min-width: 0; }
  .name { font-size: var(--text-display); font-weight: var(--fw-bold); line-height: var(--lh-tight); color: var(--color-text-primary); letter-spacing: -0.01em; }
  .tagline { font-size: var(--text-body-sm); color: var(--color-text-muted); margin-top: 2px; }

  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .stat { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0 var(--space-3); border-left: 1px solid var(--color-border); }
  .stat:first-child { padding-left: 0; border-left: 0; }
  .num {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 26px; font-weight: var(--fw-bold); line-height: 1;
    color: var(--color-text-primary); font-variant-numeric: tabular-nums;
  }
  .lbl { display: inline-flex; align-items: center; gap: 2px; min-height: 18px; font-size: var(--text-caption); color: var(--color-text-muted); }
  .sub { font-size: var(--text-caption); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }

  /* Someone is at work: the dot breathes. */
  .live { width: 9px; height: 9px; border-radius: var(--radius-full); background: var(--color-info); animation: hero-live 1.6s ease-in-out infinite; }
  @keyframes hero-live {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-info) 45%, transparent); }
    50% { box-shadow: 0 0 0 5px transparent; }
  }
  @media (prefers-reduced-motion: reduce) { .live { animation: none; } }

  /* The floor bleeds to the card's edges and fades into it on the text side. */
  .art {
    position: relative; min-height: 264px;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 22%);
    mask-image: linear-gradient(to right, transparent 0, #000 22%);
  }
  /* Out of flow, so the card is as tall as its text column and no taller. */
  .floor { position: absolute; inset: 0; }
  .enter {
    position: absolute; right: var(--space-3); bottom: var(--space-3);
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: var(--radius-full);
    border: 1px solid var(--color-border); background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
    font-size: var(--text-caption); font-weight: var(--fw-medium); color: var(--color-text-secondary);
    pointer-events: none;
  }
  .art:hover .enter { color: var(--color-text-primary); border-color: var(--color-border-strong); }

  @media (max-width: 900px) {
    .hero { grid-template-columns: minmax(0, 1fr); }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: var(--space-3); }
    .stat:nth-child(odd) { padding-left: 0; border-left: 0; }
    .art {
      min-height: 200px;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 22%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 22%);
    }
  }
</style>
