<script lang="ts">
  /**
   * Tasks and cost per day, as two small bar charts stacked on one day axis.
   * Two measures on different scales get a plot each instead of a second
   * y-axis. Pointing at a day lights its column in both plots and turns each
   * heading into that day's readout.
   */
  import { i18n } from "$lib/stores/i18n.svelte";
  import { formatCost } from "$lib/office/format";
  import type { DayPoint } from "$lib/office/stats";

  interface Props {
    /** One point per day, oldest first, today last. */
    points: DayPoint[];
  }
  let { points }: Props = $props();

  /** Height of the bar area in px. Bars are sized in px so they never depend on percentage resolution. */
  const PLOT_H = 52;

  let hover = $state<number | null>(null);
  const hovered = $derived(hover == null ? null : (points[hover] ?? null));

  const maxTasks = $derived(Math.max(1, ...points.map((p) => p.tasks)));
  const maxSpend = $derived(Math.max(0.01, ...points.map((p) => p.spend)));
  const totalTasks = $derived(points.reduce((n, p) => n + p.tasks, 0));
  const totalSpend = $derived(points.reduce((n, p) => n + p.spend, 0));

  const barH = (value: number, max: number) => (value <= 0 ? 0 : Math.max(2, Math.round((value / max) * PLOT_H)));

  const dayLabel = (p: DayPoint) =>
    new Date(p.dayMs).toLocaleDateString(i18n.locale, { weekday: "short", month: "short", day: "numeric" });

  /** Every second day counting back from today; the month is named on the first label and when it changes. */
  const ticks = $derived.by(() => {
    const out: string[] = [];
    let month = -1;
    points.forEach((p, i) => {
      if ((points.length - 1 - i) % 2 !== 0) return void out.push("");
      const d = new Date(p.dayMs);
      const withMonth = d.getMonth() !== month;
      month = d.getMonth();
      out.push(
        withMonth
          ? d.toLocaleDateString(i18n.locale, { month: "short", day: "numeric" })
          : String(d.getDate()),
      );
    });
    return out;
  });

  /** The whole column is the target, not the bar: a zero day can be read too. */
  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || points.length === 0) return;
    const i = Math.floor(((e.clientX - r.left) / r.width) * points.length);
    hover = Math.max(0, Math.min(points.length - 1, i));
  }
</script>

<div class="chart">
  <div class="plots" aria-hidden="true" onpointermove={onMove} onpointerleave={() => (hover = null)}>
    <div class="series">
      <div class="s-head">
        <span class="s-name">{i18n.t("dashboard.ops.tasksSeries")}</span>
        <span class="s-ctx">{hovered ? dayLabel(hovered) : i18n.t("dashboard.ops.total")}</span>
        <span class="s-val">{hovered ? hovered.tasks : totalTasks}</span>
      </div>
      <div class="plot" style="--plot-h:{PLOT_H}px">
        <span class="peak">{maxTasks}</span>
        {#each points as p, i (p.dayMs)}
          <span class="col" class:on={hover === i}>
            {#if p.tasks > 0}<span class="bar" style="height:{barH(p.tasks, maxTasks)}px"></span>{/if}
          </span>
        {/each}
      </div>
    </div>

    <div class="series">
      <div class="s-head">
        <span class="s-name">{i18n.t("dashboard.ops.costSeries")}</span>
        <span class="s-ctx">{hovered ? dayLabel(hovered) : i18n.t("dashboard.ops.total")}</span>
        <span class="s-val">{formatCost(hovered ? hovered.spend : totalSpend)}</span>
      </div>
      <div class="plot" style="--plot-h:{PLOT_H}px">
        <span class="peak">{formatCost(maxSpend)}</span>
        {#each points as p, i (p.dayMs)}
          <span class="col" class:on={hover === i}>
            {#if p.spend > 0}<span class="bar" style="height:{barH(p.spend, maxSpend)}px"></span>{/if}
          </span>
        {/each}
      </div>
    </div>

    <div class="axis">
      {#each ticks as label, i (i)}
        <span class="tick" class:on={hover === i}>{label}</span>
      {/each}
    </div>
  </div>

  <table class="sr-only">
    <caption>{i18n.t("dashboard.ops.activity")}</caption>
    <thead>
      <tr>
        <th scope="col">{i18n.t("dashboard.ops.day")}</th>
        <th scope="col">{i18n.t("dashboard.ops.tasksSeries")}</th>
        <th scope="col">{i18n.t("dashboard.ops.costSeries")}</th>
      </tr>
    </thead>
    <tbody>
      {#each points as p (p.dayMs)}
        <tr><th scope="row">{dayLabel(p)}</th><td>{p.tasks}</td><td>{formatCost(p.spend)}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .chart { min-width: 0; }
  .plots { display: flex; flex-direction: column; gap: var(--space-3); cursor: default; }
  .series { display: flex; flex-direction: column; gap: 4px; }

  .s-head { display: flex; align-items: baseline; gap: var(--space-2); }
  .s-name { font-size: var(--text-body-sm); font-weight: var(--fw-medium); color: var(--color-text-primary); }
  .s-ctx { flex: 1; min-width: 0; font-size: var(--text-caption); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-val { flex: none; font-size: var(--text-body); font-weight: var(--fw-semibold); color: var(--color-text-primary); font-variant-numeric: tabular-nums; }

  /* 12px of headroom holds the scale label; the hairline under it is the peak. */
  .plot {
    position: relative; display: flex; align-items: stretch;
    height: calc(var(--plot-h) + 13px); padding-top: 12px;
    border-bottom: 1px solid var(--color-border-strong);
  }
  .plot::before {
    content: ""; position: absolute; left: 0; right: 0; top: 12px;
    border-top: 1px dashed var(--color-border);
  }
  .peak {
    position: absolute; right: 0; top: 0;
    font-size: 10px; line-height: 12px; color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .col {
    position: relative; flex: 1; min-width: 0;
    display: flex; align-items: flex-end; justify-content: center;
    padding: 0 1px; border-radius: 3px 3px 0 0;
  }
  .col.on { background: var(--color-surface-sunken); }
  .bar { display: block; width: min(14px, 100%); border-radius: 4px 4px 0 0; background: var(--color-brand); }
  .col.on .bar { background: var(--color-brand-hover); }

  .axis { display: flex; margin-top: calc(var(--space-2) * -1); }
  .tick {
    flex: 1; min-width: 0; display: flex; justify-content: center;
    font-size: 10px; line-height: 14px; color: var(--color-text-muted);
    white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .tick.on { color: var(--color-text-primary); }
</style>
