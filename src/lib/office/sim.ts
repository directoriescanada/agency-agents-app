/**
 * Life on the office floor: who is away from their desk, where they are
 * walking, and the papers in the air.
 *
 * The renderer stays a function of what it is handed. This module owns the
 * only moving state. An actor exists for an agent only while they are away
 * from their chair, so a floor where nobody is walking costs nothing.
 *
 * Getting around: inside a department an agent keeps to the aisle beside
 * their desk column and leaves through the open front. Between pods they
 * follow a path found on a half-tile grid on which departments, glass walls
 * and lobby furniture are solid.
 */
import type { OfficeTaskEvent } from "$lib/types";
import { lobbyPlan, type Desk, type Layout, type Pod } from "./scene";

export interface Pt {
  x: number;
  y: number;
}

// ---------- Walk grid and pathfinding (pure) ----------

/** Grid cell size in tiles. Corridors are 2 tiles wide, so they keep at least two open columns. */
const RES = 0.5;
/** Open ground kept around the floor so a path can go round the outside. */
const MARGIN = 3;

export interface WalkGrid {
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** 1 where nobody can stand. */
  solid: Uint8Array;
}

export function buildWalkGrid(layout: Layout): WalkGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of layout.pods) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const x0 = Math.floor(minX) - MARGIN;
  const y0 = Math.floor(minY) - MARGIN;
  const cols = Math.ceil((maxX + MARGIN - x0) / RES);
  const rows = Math.ceil((maxY + MARGIN - y0) / RES);
  const solid = new Uint8Array(cols * rows);

  /** Mark every cell whose centre lies in the rect grown by `pad`. */
  const fill = (x: number, y: number, w: number, h: number, pad: number) => {
    const c0 = Math.max(0, Math.ceil((x - pad - x0) / RES - 0.5));
    const c1 = Math.min(cols - 1, Math.floor((x + w + pad - x0) / RES - 0.5));
    const r0 = Math.max(0, Math.ceil((y - pad - y0) / RES - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((y + h + pad - y0) / RES - 0.5));
    for (let r = r0; r <= r1; r++) solid.fill(1, r * cols + c0, r * cols + c1 + 1);
  };

  for (const p of layout.pods) {
    if (p.kind !== "lobby") {
      // Desk rows are crossed along scripted aisles, never by the grid.
      fill(p.x, p.y, p.w, p.h, 0.35);
      continue;
    }
    // The lobby is open floor behind two glass walls, with furniture on it.
    fill(p.x, p.y, 0, p.h, 0.3);
    fill(p.x, p.y, p.w, 0, 0.3);
    const plan = lobbyPlan(p);
    for (const f of [plan.counter, plan.board, plan.coffee]) fill(f.x, f.y, f.w, f.h, 0.3);
    // Nor right behind the board or the counter: the lobby is drawn as one
    // piece, so someone standing there would show through it.
    fill(plan.board.x - 0.9, plan.board.y - 0.9, plan.board.w + 0.9, 0.9, 0.3);
    fill(plan.counter.x - 0.5, plan.counter.y - 0.5, plan.counter.w + 0.5, 0.5, 0.3);
    for (const pl of plan.plants) fill(pl.x - 0.18, pl.y - 0.18, 0.36, 0.36, 0.2);
  }
  return { x0, y0, cols, rows, solid };
}

function cellAt(g: WalkGrid, x: number, y: number): number {
  const c = Math.floor((x - g.x0) / RES);
  const r = Math.floor((y - g.y0) / RES);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
  return r * g.cols + c;
}

const centre = (g: WalkGrid, i: number): Pt => ({
  x: g.x0 + ((i % g.cols) + 0.5) * RES,
  y: g.y0 + (Math.floor(i / g.cols) + 0.5) * RES,
});

/** The open cell at or nearest to a point, or -1. */
function nearestOpen(g: WalkGrid, p: Pt): number {
  const c = Math.max(0, Math.min(g.cols - 1, Math.floor((p.x - g.x0) / RES)));
  const r = Math.max(0, Math.min(g.rows - 1, Math.floor((p.y - g.y0) / RES)));
  for (let ring = 0; ring <= 8; ring++) {
    let best = -1;
    let bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
        const i = rr * g.cols + cc;
        if (g.solid[i]) continue;
        const q = centre(g, i);
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Whether the straight line between two points stays on open ground. */
function clear(g: WalkGrid, a: Pt, b: Pt): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const cell = cellAt(g, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
    if (cell < 0 || g.solid[cell]) return false;
  }
  return true;
}

/**
 * A walkable path from `from` to `to`, both included, or `null` when the two
 * are not connected. A* over 4-neighbour cells, then the corners that a
 * straight line can skip are dropped, so people cut across open floor instead
 * of marching in steps.
 */
export function findPath(g: WalkGrid, from: Pt, to: Pt): Pt[] | null {
  const start = nearestOpen(g, from);
  const goal = nearestOpen(g, to);
  if (start < 0 || goal < 0) return null;

  const n = g.cols * g.rows;
  const cost = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const gc = goal % g.cols;
  const gr = Math.floor(goal / g.cols);
  const h = (i: number) => Math.abs((i % g.cols) - gc) + Math.abs(Math.floor(i / g.cols) - gr);

  // Binary min-heap of cell indexes keyed by f.
  const heap: number[] = [];
  const key: number[] = [];
  const push = (i: number, f: number) => {
    let k = heap.length;
    heap.push(i);
    key.push(f);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (key[parent] <= key[k]) break;
      [heap[parent], heap[k]] = [heap[k], heap[parent]];
      [key[parent], key[k]] = [key[k], key[parent]];
      k = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const lastI = heap.pop() as number;
    const lastF = key.pop() as number;
    if (heap.length > 0) {
      heap[0] = lastI;
      key[0] = lastF;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && key[l] < key[m]) m = l;
        if (r < heap.length && key[r] < key[m]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        [key[m], key[k]] = [key[k], key[m]];
        k = m;
      }
    }
    return top;
  };

  cost[start] = 0;
  push(start, h(start));
  let found = false;
  while (heap.length > 0) {
    const cur = pop();
    if (cur === goal) {
      found = true;
      break;
    }
    const c = cur % g.cols;
    const r = Math.floor(cur / g.cols);
    const next = cost[cur] + 1;
    const visit = (i: number) => {
      if (g.solid[i] || next >= cost[i]) return;
      cost[i] = next;
      prev[i] = cur;
      push(i, next + h(i));
    };
    if (c > 0) visit(cur - 1);
    if (c < g.cols - 1) visit(cur + 1);
    if (r > 0) visit(cur - g.cols);
    if (r < g.rows - 1) visit(cur + g.cols);
  }
  if (!found) return null;

  const cells: Pt[] = [];
  for (let i = goal; i >= 0; i = prev[i]) cells.push(centre(g, i));
  cells.reverse();
  const pts = [from, ...cells, to];

  const out: Pt[] = [from];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(g, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

// ---------- Places ----------

/** Where an agent sits. Matches the chair the renderer draws. */
export const seatOf = (d: Desk): Pt => ({ x: d.cx + 1.0, y: d.cy + 0.6 });
/** The aisle beside a desk: the gap between its column and the next. */
const aisleOf = (d: Desk): Pt => ({ x: d.cx + 2.0, y: d.cy + 0.6 });
/** Just outside the open front of a desk's pod, in line with its aisle. */
const exitOf = (d: Desk): Pt => ({ x: d.cx + 2.0, y: d.pod.y + d.pod.h + 0.6 });

/** A point in the air, in tiles. */
export interface Pt3 extends Pt {
  z: number;
}

// ---------- Actors and papers ----------

export type Pose = "stand" | "walk";

export interface Actor {
  slug: string;
  desk: Desk;
  x: number;
  y: number;
  /** Facing, a world-space unit vector. */
  fx: number;
  fy: number;
  pose: Pose;
  /** Tiles walked so far; drives the stride. */
  stride: number;
  /** A coffee on the way back from the corner. */
  carrying: "cup" | null;

  speed: number;
  state: "rising" | "out" | "paused" | "back" | "sitting";
  /** Seconds left in a timed state. */
  timer: number;
  /** Points still to walk, next first. */
  path: Pt[];
  /** The way home: every point passed on the way out, last passed first. */
  home: Pt[];
  stop: Stop;
}

/** What an agent does where the trip ends. */
interface Stop {
  kind: "colleague" | "doorway" | "coffee" | "huddle";
  seconds: number;
  /** Which way to face while standing there. */
  fx: number;
  fy: number;
  /** Coffee-corner place held for the length of the trip. */
  slot?: number;
}

export interface Paper {
  x: number;
  y: number;
  z: number;
  /** 0 to 1 along the flight. */
  u: number;
  from: Pt3;
  to: Pt3;
  seconds: number;
  lift: number;
}

export interface SimContext {
  /** Camera zoom. Nobody sets out when the floor is too small to see them. */
  zoom: number;
  /** True when the agent has nothing running and nothing just finished. */
  isIdle: (slug: string) => boolean;
  /** Whether a floor point is on screen, so walks start where someone is looking. */
  inView?: (x: number, y: number) => boolean;
}

const MAX_WANDERERS = 3;
const MIN_ZOOM = 0.2;
const COFFEE_SLOTS = 3;
/** The longest a desk waits for its owner once a task has landed on it. */
const RECALL_SECONDS = 5;

/** Walking pace in tiles per second; everyone has their own. */
const paceOf = (d: Desk): number => 1.4 + d.phase * 0.5;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

export class OfficeSim {
  /** Reduced motion: nobody wanders and nothing flies. */
  calm = false;
  papers: Paper[] = [];

  private layout: Layout | null = null;
  private grid: WalkGrid | null = null;
  private desks = new Map<string, Desk>();
  private actors = new Map<string, Actor>();
  private coffee: (string | null)[] = [];
  private nextWander = rand(2, 4);

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.grid = buildWalkGrid(layout);
    this.desks = new Map(layout.desks.map((d) => [d.agent.slug, d]));
    // A new floor: everyone is back at their (new) desk.
    this.actors.clear();
    this.papers = [];
    this.coffee = Array.from({ length: COFFEE_SLOTS }, () => null);
  }

  /** False while the agent is anywhere but in their chair. */
  isAtDesk(slug: string): boolean {
    return !this.actors.has(slug);
  }

  /** Everyone currently away from their desk. */
  get moving(): Iterable<Actor> {
    return this.actors.values();
  }

  tick(dt: number, ctx: SimContext): void {
    if (!this.layout || dt <= 0) return;

    for (const a of this.actors.values()) this.step(a, dt);
    for (const a of [...this.actors.values()]) {
      if (a.state === "sitting" && a.timer <= 0) this.seat(a);
    }

    for (const p of this.papers) {
      p.u = Math.min(1, p.u + dt / p.seconds);
      const e = p.u * p.u * (3 - 2 * p.u);
      p.x = p.from.x + (p.to.x - p.from.x) * e;
      p.y = p.from.y + (p.to.y - p.from.y) * e;
      p.z = p.from.z + (p.to.z - p.from.z) * e + Math.sin(Math.PI * p.u) * p.lift;
    }
    if (this.papers.some((p) => p.u >= 1)) this.papers = this.papers.filter((p) => p.u < 1);

    if (this.calm) return;
    this.nextWander -= dt;
    if (this.nextWander <= 0) {
      this.nextWander = rand(8, 15);
      if (ctx.zoom >= MIN_ZOOM && this.actors.size < MAX_WANDERERS) this.wander(ctx);
    }
  }

  /** Keep the floor in step with the task runner. */
  onTaskEvent(ev: OfficeTaskEvent): void {
    const lobby = this.layout?.lobby;
    if (!lobby) return;
    if (ev.kind !== "started" && ev.kind !== "finished") return;
    const desk = this.desks.get(ev.task.agentSlug);
    if (!desk) return;
    const b = lobbyPlan(lobby).board;
    const board: Pt3 = { x: b.x + b.w / 2, y: b.y, z: 1.25 };
    const tray: Pt3 = { x: desk.cx + 1.45, y: desk.cy + 1.3, z: 0.5 };
    if (ev.kind === "started") {
      // The brief leaves the task board for the desk; whoever is out heads back for it.
      this.recall(ev.task.agentSlug);
      this.fly(board, tray);
    } else if (ev.task.status === "done") {
      this.fly(tray, board);
    }
  }

  /** Send a sheet of paper through the air. */
  fly(from: Pt3, to: Pt3): void {
    if (this.calm) return;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    this.papers.push({
      x: from.x,
      y: from.y,
      z: from.z,
      u: 0,
      from,
      to,
      seconds: Math.max(0.7, Math.min(2.4, dist / 7)),
      lift: Math.min(3.2, 0.9 + dist * 0.1),
    });
  }

  /** Turn someone round, wherever they are, and hurry them back to their chair. */
  recall(slug: string): void {
    const a = this.actors.get(slug);
    if (!a || a.state === "sitting") return;
    if (a.state !== "back") this.turnBack(a);
    // However far they went, the desk is not left dark for long: a jog nearby, a dash from the lobby.
    let left = 0;
    let from: Pt = a;
    for (const p of a.path) {
      left += Math.hypot(p.x - from.x, p.y - from.y);
      from = p;
    }
    a.speed = Math.max(a.speed, paceOf(a.desk) * 1.5, left / RECALL_SECONDS);
  }

  // ---------- Internals ----------

  private step(a: Actor, dt: number): void {
    switch (a.state) {
      case "rising":
      case "sitting":
        a.timer -= dt;
        if (a.state === "rising" && a.timer <= 0) a.state = "out";
        return;
      case "paused": {
        a.timer -= dt;
        // Coffee: fill the cup facing the machine, then turn round and drink it.
        if (a.stop.kind === "coffee" && a.timer < a.stop.seconds * 0.6 && !a.carrying) {
          a.carrying = "cup";
          a.fx = 0;
          a.fy = 1;
        }
        if (a.timer <= 0) this.turnBack(a);
        return;
      }
      case "out":
      case "back": {
        a.pose = "walk";
        let left = a.speed * dt;
        while (left > 0 && a.path.length > 0) {
          const p = a.path[0];
          const dx = p.x - a.x;
          const dy = p.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d > 1e-6) {
            a.fx = dx / d;
            a.fy = dy / d;
          }
          if (d <= left) {
            a.x = p.x;
            a.y = p.y;
            a.stride += d;
            left -= d;
            a.path.shift();
            if (a.state === "out") a.home.unshift(p);
          } else {
            a.x += a.fx * left;
            a.y += a.fy * left;
            a.stride += left;
            left = 0;
          }
        }
        if (a.path.length > 0) return;
        a.pose = "stand";
        if (a.state === "out") {
          a.state = "paused";
          a.timer = a.stop.seconds;
          a.fx = a.stop.fx;
          a.fy = a.stop.fy;
        } else {
          // Back at the chair: a beat on their feet, then down.
          a.state = "sitting";
          a.timer = 0.25;
          a.fx = 0;
          a.fy = 1;
        }
        return;
      }
    }
  }

  private turnBack(a: Actor): void {
    a.path = a.home;
    a.home = [];
    a.state = "back";
    if (a.path.length === 0) a.path = [seatOf(a.desk)];
  }

  private seat(a: Actor): void {
    if (a.stop.slot != null && this.coffee[a.stop.slot] === a.slug) this.coffee[a.stop.slot] = null;
    this.actors.delete(a.slug);
  }

  /** Stand an agent up and send them along `route` (which starts at their seat). */
  private depart(desk: Desk, route: Pt[], stop: Stop): Actor {
    const seat = seatOf(desk);
    const a: Actor = {
      slug: desk.agent.slug,
      desk,
      x: seat.x,
      y: seat.y,
      fx: 0,
      fy: 1,
      pose: "stand",
      stride: desk.phase * 10,
      carrying: null,
      speed: paceOf(desk),
      state: "rising",
      timer: 0.3,
      path: route.slice(1),
      home: [seat],
      stop,
    };
    this.actors.set(a.slug, a);
    return a;
  }

  /** Pick an idle agent, preferably one on screen, and give them somewhere to go. */
  private wander(ctx: SimContext): void {
    const layout = this.layout;
    const grid = this.grid;
    if (!layout || !grid || layout.desks.length === 0) return;

    let desk: Desk | null = null;
    for (let tries = 0; tries < 40; tries++) {
      const d = pick(layout.desks);
      if (this.actors.has(d.agent.slug) || !ctx.isIdle(d.agent.slug)) continue;
      const s = seatOf(d);
      if (ctx.inView && !ctx.inView(s.x, s.y)) {
        desk ??= d;
        continue;
      }
      desk = d;
      break;
    }
    if (!desk) return;

    const roll = Math.random();
    if (roll < 0.4 && this.visitColleague(desk)) return;
    if (roll < 0.75 && this.fetchCoffee(desk, grid, layout.lobby)) return;
    if (this.visitDoorway(desk, grid, layout)) return;
    this.visitColleague(desk);
  }

  /** Walk over to someone in the same department and stand at their desk. */
  private visitColleague(desk: Desk): boolean {
    const others = desk.pod.desks.filter((d) => d !== desk && !this.actors.has(d.agent.slug));
    if (others.length === 0) return false;
    const other = pick(others);
    const a = aisleOf(desk);
    const b = aisleOf(other);
    const route = [seatOf(desk), a];
    if (Math.abs(a.x - b.x) > 0.01) {
      // Along the walkway inside the pod's open front, then up the other aisle.
      const walkway = desk.pod.y + desk.pod.h - 0.35;
      route.push({ x: a.x, y: walkway }, { x: b.x, y: walkway });
    }
    route.push(b);
    this.depart(desk, route, { kind: "colleague", seconds: rand(3, 6), fx: -1, fy: 0 });
    return true;
  }

  /** Stand at the open front of a nearby department for a word. */
  private visitDoorway(desk: Desk, grid: WalkGrid, layout: Layout): boolean {
    const here = desk.pod;
    const mid = (p: Pod) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
    const from = mid(here);
    const near = layout.pods
      .filter((p) => p.kind === "department" && p !== here && p.desks.length > 0)
      .map((p) => ({ p, d: Math.hypot(mid(p).x - from.x, mid(p).y - from.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    if (near.length === 0) return false;
    const pod = pick(near).p;
    const target = { x: pod.x + pod.w / 2 + rand(-0.8, 0.8), y: pod.y + pod.h + 0.7 };
    const path = findPath(grid, exitOf(desk), target);
    if (!path) return false;
    this.depart(desk, [seatOf(desk), aisleOf(desk), ...path], { kind: "doorway", seconds: rand(3, 6), fx: 0, fy: -1 });
    return true;
  }

  /** Walk to the coffee corner in the lobby, fill a cup, bring it back. */
  private fetchCoffee(desk: Desk, grid: WalkGrid, lobby: Pod): boolean {
    const slot = this.coffee.findIndex((s) => s == null);
    if (slot < 0) return false;
    const c = lobbyPlan(lobby).coffee;
    const target = { x: c.x + 0.5 + slot * 0.7, y: c.y + c.h + 0.6 };
    const path = findPath(grid, exitOf(desk), target);
    if (!path) return false;
    this.coffee[slot] = desk.agent.slug;
    this.depart(desk, [seatOf(desk), aisleOf(desk), ...path], { kind: "coffee", seconds: rand(4, 6.5), fx: 0, fy: -1, slot });
    return true;
  }
}
