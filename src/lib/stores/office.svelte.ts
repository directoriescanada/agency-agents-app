/**
 * Office store — tasks running in the isometric office, and the agents'
 * live status derived from them.
 *
 * Backed by the `office_*` Tauri commands and the `office:task` event
 * stream (`src-tauri/src/office/mod.rs`). Finished tasks are reloaded from
 * `tasks.jsonl` on first use so the feed survives a relaunch; running ones
 * exist only while the app is open.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Agent, OfficeRouteResult, OfficeRunnerStatus, OfficeTask, OfficeTaskEvent } from "$lib/types";
import { errorText } from "$lib/types";
import { topLevel } from "$lib/office/stats";

/** Live status of an agent at their desk, as the office draws it. */
export type DeskStatus = "idle" | "working" | "done" | "error";

/** How long a finished task keeps the desk in its "done"/"error" pose. */
const SETTLE_MS = 12_000;

const STOP_WORDS = new Set(
  "a an the and or of for to in on with by from at as is are be this that it my our your we you i me us them their his her its into about over under up down out new make write create build do get set please can should would need want help".split(
    " ",
  ),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

class OfficeStore {
  tasks: OfficeTask[] = $state([]);
  runner: OfficeRunnerStatus | null = $state(null);
  runnerChecked = $state(false);
  /** True once the saved history has been read (or failed to). */
  historyLoaded = $state(false);
  error: string | null = $state(null);
  /** Agent slug the office has focused (clicked desk). */
  selectedAgent: string | null = $state(null);
  /** Task open in the detail pane. */
  selectedTask: string | null = $state(null);
  /** Department the composer is filtered to; `null` = any. */
  composerDepartment: string | null = $state(null);
  /** Agent the composer will dispatch to; `null` = pick for me. */
  composerAgent: string | null = $state(null);
  /** One agent, or a lead who splits the task across a team. */
  composerMode: "solo" | "team" = $state("solo");
  /** Team mode: the lead; `null` = Claude picks. */
  composerLead: string | null = $state(null);
  /**
   * Team mode: where the members come from. `null` = the lead picks 2 to 5
   * from the department; `preset:<slug>` or `saved:<id>` = that team.
   */
  composerTeam: string | null = $state(null);
  draft = $state("");

  /** Ticks once a second so "done" poses expire and timers re-render. */
  now = $state(Date.now());

  private unlisten: UnlistenFn | null = null;
  private loaded = false;
  private clock: ReturnType<typeof setInterval> | null = null;
  private watchers = new Set<(ev: OfficeTaskEvent) => void>();

  /** Subscribe to task events and load history. Idempotent. */
  async start(): Promise<void> {
    if (!this.unlisten) {
      this.unlisten = await listen<OfficeTaskEvent>("office:task", (e) => this.apply(e.payload));
    }
    if (!this.clock) {
      this.clock = setInterval(() => (this.now = Date.now()), 1000);
    }
    if (!this.loaded) {
      this.loaded = true;
      try {
        const [history, runner] = await Promise.all([
          invoke<OfficeTask[]>("office_tasks_history"),
          invoke<OfficeRunnerStatus>("office_runner_status"),
        ]);
        // Keep anything that arrived via events while history was loading.
        const live = this.tasks.filter((t) => t.status === "running");
        this.tasks = [...history, ...live.filter((l) => !history.some((h) => h.id === l.id))];
        this.runner = runner;
      } catch (err) {
        this.error = errorText(err);
      } finally {
        this.runnerChecked = true;
        this.historyLoaded = true;
      }
    }
  }

  async refreshRunner(): Promise<void> {
    try {
      this.runner = await invoke<OfficeRunnerStatus>("office_runner_status");
    } catch (err) {
      this.error = errorText(err);
    } finally {
      this.runnerChecked = true;
    }
  }

  /**
   * Watch raw task events as they arrive, each exactly once. For things that
   * animate on the moment something happens (a paper leaving the board)
   * rather than on what the task list says. Returns the unsubscribe.
   */
  subscribe(fn: (ev: OfficeTaskEvent) => void): () => void {
    this.watchers.add(fn);
    return () => void this.watchers.delete(fn);
  }

  private apply(ev: OfficeTaskEvent): void {
    for (const fn of this.watchers) fn(ev);
    if (ev.kind === "started") {
      if (!this.tasks.some((t) => t.id === ev.task.id)) this.tasks = [...this.tasks, ev.task];
      return;
    }
    if (ev.kind === "finished") {
      const i = this.tasks.findIndex((t) => t.id === ev.task.id);
      if (i >= 0) {
        const next = this.tasks.slice();
        next[i] = ev.task;
        this.tasks = next;
      } else {
        this.tasks = [...this.tasks, ev.task];
      }
      return;
    }
    const i = this.tasks.findIndex((t) => t.id === ev.taskId);
    if (i < 0) return;
    const t = this.tasks[i];
    const next = this.tasks.slice();
    if (ev.kind === "delta") {
      next[i] = { ...t, output: t.output + ev.text };
    } else if (ev.kind === "tool") {
      next[i] = { ...t, toolsUsed: t.toolsUsed.includes(ev.tool) ? t.toolsUsed : [...t.toolsUsed, ev.tool] };
    } else if (ev.kind === "phase") {
      next[i] = { ...t, phase: ev.phase, members: ev.members };
    }
    this.tasks = next;
  }

  /** Hand `prompt` to `agentSlug`. Resolves with the running task. */
  async dispatch(agentSlug: string, prompt: string, agencyName: string): Promise<OfficeTask> {
    this.error = null;
    const task = await invoke<OfficeTask>("office_task_start", { agentSlug, prompt, agencyName });
    if (!this.tasks.some((t) => t.id === task.id)) this.tasks = [...this.tasks, task];
    return task;
  }

  /**
   * Hand `prompt` to a team. The lead plans the split, the members work
   * their parts side by side, the lead merges them into one deliverable.
   * `memberSlugs` fixes the team; when it is empty the lead picks 2 to 5
   * from `candidateSlugs`. Resolves with the team task (the lead's record);
   * the parts arrive as events once the plan is in.
   */
  async dispatchTeam(
    leadSlug: string,
    memberSlugs: string[],
    candidateSlugs: string[],
    prompt: string,
    agencyName: string,
  ): Promise<OfficeTask> {
    this.error = null;
    const task = await invoke<OfficeTask>("office_team_start", {
      prompt,
      leadSlug,
      memberSlugs,
      candidateSlugs,
      agencyName,
    });
    if (!this.tasks.some((t) => t.id === task.id)) this.tasks = [...this.tasks, task];
    return task;
  }

  async cancel(taskId: string): Promise<void> {
    try {
      await invoke<boolean>("office_task_cancel", { taskId });
    } catch (err) {
      this.error = errorText(err);
    }
  }

  // ---------- Derived views ----------

  /** Claude Code is installed and (as far as we can tell) signed in. */
  get runnerReady(): boolean {
    return this.runner?.available === true && this.runner?.loggedIn !== false;
  }

  /** Every running record, parts included: who is busy at a desk. */
  get running(): OfficeTask[] {
    return this.tasks.filter((t) => t.status === "running");
  }

  /**
   * Tasks as the user handed them out: solo and team tasks. A part shows
   * under its team task, so it is left out here (unless that team task is
   * gone, in which case the part stands on its own).
   */
  top: OfficeTask[] = $derived(topLevel(this.tasks));

  /** Running tasks as the user counts them: a team task is one. */
  get runningTop(): OfficeTask[] {
    return this.top.filter((t) => t.status === "running");
  }

  /** Newest first. */
  get feed(): OfficeTask[] {
    return this.top.slice().reverse();
  }

  /** The parts of a team task, in the order the lead named the members. */
  childrenOf(taskId: string): OfficeTask[] {
    const order = this.tasks.find((t) => t.id === taskId)?.members ?? [];
    const rank = (t: OfficeTask): number => {
      const i = order.indexOf(t.agentSlug);
      return i < 0 ? order.length : i;
    };
    return this.tasks.filter((t) => t.parentId === taskId).sort((a, b) => rank(a) - rank(b));
  }

  /** The team task a part belongs to, when it is still in the list. */
  parentOf(task: OfficeTask): OfficeTask | null {
    if (!task.parentId) return null;
    return this.tasks.find((t) => t.id === task.parentId) ?? null;
  }

  /**
   * What a task cost in all. A team task's own figure covers the lead's
   * planning and merge; its parts carry theirs. `null` when nothing has
   * reported a cost yet.
   */
  totalCost(task: OfficeTask): number | null {
    let sum = task.costUsd ?? 0;
    let known = task.costUsd != null;
    if (task.kind === "team") {
      for (const part of this.tasks) {
        if (part.parentId !== task.id || part.costUsd == null) continue;
        sum += part.costUsd;
        known = true;
      }
    }
    return known ? sum : null;
  }

  tasksFor(agentSlug: string): OfficeTask[] {
    return this.tasks.filter((t) => t.agentSlug === agentSlug).reverse();
  }

  /** What the desk should show right now. */
  deskStatus(agentSlug: string): DeskStatus {
    let latest: OfficeTask | null = null;
    for (const t of this.tasks) {
      if (t.agentSlug !== agentSlug) continue;
      if (t.status === "running") return "working";
      latest = t;
    }
    if (!latest || !latest.finishedAt) return "idle";
    const age = this.now - Date.parse(latest.finishedAt);
    if (age > SETTLE_MS) return "idle";
    return latest.status === "done" ? "done" : latest.status === "error" ? "error" : "idle";
  }

  /** The pool a prompt is routed within. */
  pool(agents: Agent[], department: string | null): Agent[] {
    const pool = department ? agents.filter((a) => a.category === department) : agents;
    return pool.length > 0 ? pool : agents;
  }

  /**
   * Local guess at the agent for a prompt — instant, no model call. Used
   * for the "Goes to" preview and as the fallback when Claude's pick is
   * unavailable. Words are weighted by how rare they are across the roster
   * (a word every agent uses says nothing), name hits count double, and a
   * busy agent yields to an idle colleague on a tie.
   */
  guess(prompt: string, agents: Agent[], department: string | null): Agent | null {
    const list = this.pool(agents, department);
    if (list.length === 0) return null;
    const words = [...new Set(tokens(prompt))];
    if (words.length === 0) return list[0];
    const docs = list.map((a) => ({
      a,
      name: new Set(tokens(a.name)),
      all: new Set(tokens(`${a.name} ${a.description} ${a.vibe ?? ""} ${a.category}`)),
    }));
    const df = new Map<string, number>();
    for (const d of docs) for (const w of d.all) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = (w: string) => Math.log((docs.length + 1) / ((df.get(w) ?? 0) + 1)) + 0.1;
    let best: Agent | null = null;
    let bestScore = -Infinity;
    for (const d of docs) {
      let score = 0;
      for (const w of words) {
        if (d.name.has(w)) score += 2 * idf(w);
        else if (d.all.has(w)) score += idf(w);
      }
      if (this.deskStatus(d.a.slug) === "working") score -= 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = d.a;
      }
    }
    return best;
  }

  /**
   * Ask Claude to pick within the pool; falls back to the local guess when
   * the model's answer is unusable or the call fails.
   */
  async route(prompt: string, agents: Agent[], department: string | null): Promise<Agent | null> {
    const list = this.pool(agents, department);
    const fallback = this.guess(prompt, agents, department);
    if (!fallback) return null;
    try {
      const r = await invoke<OfficeRouteResult>("office_route", {
        prompt,
        candidates: list.map((a) => a.slug),
        fallback: fallback.slug,
      });
      return list.find((a) => a.slug === r.agentSlug) ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export const office = new OfficeStore();
