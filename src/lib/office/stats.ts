/**
 * Office statistics — pure functions over the task history.
 *
 * The backend keeps the last 200 finished tasks, so every figure here is a
 * cheap pass over a short array; nothing is cached. Days are local calendar
 * days (a task belongs to the day it started; its cost to the day it
 * finished, which is when Claude Code reports it).
 */

import type { OfficeTask } from "$lib/types";

/** Midnight (local time) of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight (local time) `days` calendar days before the day containing `ms`. */
export function daysAgo(ms: number, days: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - days);
  return d.getTime();
}

const startedMs = (t: OfficeTask): number => Date.parse(t.startedAt);
const finishedMs = (t: OfficeTask): number | null => (t.finishedAt ? Date.parse(t.finishedAt) : null);

/** How long a finished task took, from the runner's own figure when it has one. */
export function durationMs(t: OfficeTask): number | null {
  if (t.durationMs != null) return t.durationMs;
  const end = finishedMs(t);
  return end == null ? null : Math.max(0, end - startedMs(t));
}

/** Tasks handed out today, whatever became of them. */
export function tasksToday(tasks: readonly OfficeTask[], nowMs: number): number {
  const from = startOfDay(nowMs);
  return tasks.filter((t) => startedMs(t) >= from).length;
}

/** Tasks that finished successfully today. */
export function doneToday(tasks: readonly OfficeTask[], nowMs: number): number {
  const from = startOfDay(nowMs);
  return tasks.filter((t) => t.status === "done" && (finishedMs(t) ?? 0) >= from).length;
}

/** Summed cost of tasks that finished in `[fromMs, toMs)`. */
export function spendBetween(tasks: readonly OfficeTask[], fromMs: number, toMs: number): number {
  let sum = 0;
  for (const t of tasks) {
    if (t.costUsd == null) continue;
    const at = finishedMs(t) ?? startedMs(t);
    if (at >= fromMs && at < toMs) sum += t.costUsd;
  }
  return sum;
}

export interface DepartmentLoad {
  slug: string;
  count: number;
}

/** Tasks per department since `sinceMs`, busiest first. */
export function perDepartment(tasks: readonly OfficeTask[], sinceMs: number): DepartmentLoad[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (startedMs(t) < sinceMs) continue;
    counts.set(t.department, (counts.get(t.department) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

export interface AgentLoad {
  slug: string;
  name: string;
  department: string;
  /** Tasks finished successfully. */
  done: number;
  /** Tasks handed out, any outcome. */
  total: number;
  /** Mean duration of the finished ones; `null` when none finished. */
  avgMs: number | null;
}

/** Per-agent output since `sinceMs`: most finished work first. */
export function perAgent(tasks: readonly OfficeTask[], sinceMs: number): AgentLoad[] {
  const rows = new Map<string, AgentLoad & { sumMs: number; timed: number }>();
  for (const t of tasks) {
    if (startedMs(t) < sinceMs) continue;
    let row = rows.get(t.agentSlug);
    if (!row) {
      row = { slug: t.agentSlug, name: t.agentName, department: t.department, done: 0, total: 0, avgMs: null, sumMs: 0, timed: 0 };
      rows.set(t.agentSlug, row);
    }
    row.total += 1;
    if (t.status !== "done") continue;
    row.done += 1;
    const ms = durationMs(t);
    if (ms != null) {
      row.sumMs += ms;
      row.timed += 1;
    }
  }
  return [...rows.values()]
    .map(({ sumMs, timed, ...row }) => ({ ...row, avgMs: timed > 0 ? sumMs / timed : null }))
    .sort((a, b) => b.done - a.done || b.total - a.total || a.name.localeCompare(b.name));
}

export interface DayPoint {
  /** Local midnight of the day. */
  dayMs: number;
  /** Tasks started that day. */
  tasks: number;
  /** Cost of tasks that finished that day. */
  spend: number;
}

/** One point per calendar day for the last `days` days, oldest first, today last. */
export function dailySeries(tasks: readonly OfficeTask[], days: number, nowMs: number): DayPoint[] {
  const points: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) points.push({ dayMs: daysAgo(nowMs, i), tasks: 0, spend: 0 });
  const index = new Map(points.map((p, i) => [p.dayMs, i]));
  for (const t of tasks) {
    const s = index.get(startOfDay(startedMs(t)));
    if (s != null) points[s].tasks += 1;
    if (t.costUsd != null) {
      const f = index.get(startOfDay(finishedMs(t) ?? startedMs(t)));
      if (f != null) points[f].spend += t.costUsd;
    }
  }
  return points;
}

/** The latest finished tasks (any outcome), newest first. */
export function recentFinished(tasks: readonly OfficeTask[], limit: number): OfficeTask[] {
  return tasks
    .filter((t) => t.status !== "running")
    .sort((a, b) => (finishedMs(b) ?? startedMs(b)) - (finishedMs(a) ?? startedMs(a)))
    .slice(0, limit);
}
