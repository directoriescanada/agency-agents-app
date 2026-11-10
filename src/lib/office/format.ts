/**
 * How office tasks are worded on screen: durations, costs, status pills,
 * timestamps. Shared by the Office panel and the dashboard so the same task
 * reads the same in both.
 */

import { invoke } from "@tauri-apps/api/core";

import { i18n } from "$lib/stores/i18n.svelte";
import { toast } from "$lib/stores/toast.svelte";
import { errorText, type OfficeTask } from "$lib/types";

/** "42s", "3m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Time a task has taken: to its finish, or to `nowMs` while it runs. */
export function formatElapsed(t: OfficeTask, nowMs: number): string {
  const end = t.finishedAt ? Date.parse(t.finishedAt) : nowMs;
  return formatDuration(end - Date.parse(t.startedAt));
}

/** "$0.19", "<$0.01"; `null` when the runner reported no cost. */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd == null) return null;
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export type TaskTone = "info" | "success" | "danger" | "neutral";

export function statusTone(t: OfficeTask): TaskTone {
  if (t.status === "running") return "info";
  if (t.status === "done") return "success";
  if (t.status === "error") return "danger";
  return "neutral";
}

export function statusLabel(t: OfficeTask): string {
  return i18n.t(`office.status.${t.status}` as Parameters<typeof i18n.t>[0]);
}

/** Clock time for today, short date otherwise. */
export function formatWhen(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date(nowMs).toDateString();
  return sameDay
    ? d.toLocaleTimeString(i18n.locale, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(i18n.locale, { month: "short", day: "numeric" });
}

/** Show a deliverable in Finder; failures surface as a toast. */
export async function revealDeliverable(path: string): Promise<void> {
  try {
    await invoke("reveal_path", { path });
  } catch (err) {
    toast.error(i18n.t("office.toast.revealFailed"), errorText(err));
  }
}
