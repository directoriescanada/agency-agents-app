/**
 * The isometric office — layout and Canvas 2D rendering.
 *
 * Pure TypeScript, no framework: `OfficeCanvas.svelte` owns the element and
 * the animation loop and hands this module the catalog shape plus a status
 * lookup. Everything is drawn procedurally (floors, walls, desks, monitors,
 * chairs, people), so there are no sprite assets to license or to repaint
 * when a division changes colour.
 *
 * World space is measured in floor tiles. A tile projects to a 2:1 diamond
 * (`TILE_W` × `TILE_H` px at zoom 1). Screen-down is +x and +y in world
 * space, so "in front of" means a larger `x + y`; the painter's order sorts
 * drawables by that sum.
 *
 * Layout: every division is a pod — a carpeted rectangle holding one desk
 * per agent in a grid — packed into shelves around a lobby that carries
 * the agency name and the live task board.
 */

import type { DeskStatus } from "$lib/stores/office.svelte";

export const TILE_W = 64;
export const TILE_H = 32;

// ---------- Input shapes ----------

export interface SceneAgent {
  slug: string;
  name: string;
  emoji: string | null;
}

export interface SceneDepartment {
  slug: string;
  label: string;
  /** Hex brand colour. */
  color: string;
  agents: SceneAgent[];
}

/**
 * Group a flat roster into departments, in the order the catalog first
 * mentions each one. Labels and colours come from the caller's lookups so
 * this module stays free of stores.
 */
export function buildDepartments(
  agents: readonly (SceneAgent & { category: string })[],
  labelOf: (slug: string) => string,
  colorOf: (slug: string) => string,
): SceneDepartment[] {
  const byCategory = new Map<string, SceneAgent[]>();
  for (const a of agents) {
    const list = byCategory.get(a.category) ?? [];
    list.push({ slug: a.slug, name: a.name, emoji: a.emoji });
    byCategory.set(a.category, list);
  }
  return [...byCategory.entries()].map(([slug, list]) => ({
    slug,
    label: labelOf(slug),
    color: colorOf(slug),
    agents: list,
  }));
}

// ---------- Layout ----------

export interface Pod {
  kind: "department" | "lobby";
  slug: string;
  label: string;
  color: string;
  /** Tile rect. */
  x: number;
  y: number;
  w: number;
  h: number;
  desks: Desk[];
}

export interface Desk {
  agent: SceneAgent;
  pod: Pod;
  /** Tile coords of the desk's 2×2 cell origin. */
  cx: number;
  cy: number;
  /** Per-desk phase so idle motion isn't in lockstep. */
  phase: number;
}

export interface Layout {
  pods: Pod[];
  desks: Desk[];
  lobby: Pod;
  /** World bounds in tiles. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const LOBBY_W = 9;
const LOBBY_H = 6;
/** A desk cell: 2 tiles wide, 1.8 deep (person at the back, desk in front). */
const CELL_W = 2;
const CELL_D = 1.8;
/** Carpet margin around a pod's desk grid. */
const PAD = 0.7;
const SHELF_MIN_W = 24;
const GAP = 2;

function hashPhase(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/** Arrange departments into pods and pods into shelves. */
export function buildLayout(departments: SceneDepartment[], agencyName: string): Layout {
  const pods: Pod[] = [];
  const desks: Desk[] = [];

  // Pod size per department: desks on a 2×2-tile grid with a 1-tile margin.
  const sized = departments
    .filter((d) => d.agents.length > 0)
    .map((d) => {
      const n = d.agents.length;
      const cols = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(n * 1.6))));
      const rows = Math.ceil(n / cols);
      return { d, cols, rows, w: cols * CELL_W + PAD * 2, h: rows * CELL_D + PAD * 2 };
    })
    .sort((a, b) => b.d.agents.length - a.d.agents.length);

  // Shelf-pack the department pods, largest first, into a block that is
  // roughly square in tiles — the isometric footprint's width is
  // proportional to (Δx + Δy), so a square block fits the viewport best.
  const area = sized.reduce((acc, s) => acc + (s.w + GAP) * (s.h + GAP), 0);
  const shelfMaxW = Math.max(SHELF_MIN_W, Math.ceil(Math.sqrt(area) * 1.1));
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;

  for (const s of sized) {
    if (shelfX + s.w > shelfMaxW && shelfX > 0) {
      shelfY += shelfH + GAP;
      shelfX = 0;
      shelfH = 0;
    }
    const pod: Pod = {
      kind: "department",
      slug: s.d.slug,
      label: s.d.label,
      color: s.d.color,
      x: shelfX,
      y: shelfY,
      w: s.w,
      h: s.h,
      desks: [],
    };
    s.d.agents.forEach((agent, i) => {
      const c = i % s.cols;
      const r = Math.floor(i / s.cols);
      const desk: Desk = {
        agent,
        pod,
        cx: pod.x + PAD + c * CELL_W,
        cy: pod.y + PAD + r * CELL_D,
        phase: hashPhase(agent.slug),
      };
      pod.desks.push(desk);
      desks.push(desk);
    });
    pods.push(pod);
    shelfX += s.w + GAP;
    shelfH = Math.max(shelfH, s.h);
  }

  const bounds = () => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of pods) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    return { minX, minY, maxX, maxY };
  };

  // The lobby sits at the front entrance: a row of its own below the pods,
  // centred on the block.
  const b0 = pods.length > 0 ? bounds() : { minX: 0, minY: 0, maxX: LOBBY_W, maxY: -GAP };
  const lobby: Pod = {
    kind: "lobby",
    slug: "__lobby",
    label: agencyName,
    color: "#d97706",
    x: Math.round((b0.minX + b0.maxX) / 2 - LOBBY_W / 2),
    y: b0.maxY + GAP,
    w: LOBBY_W,
    h: LOBBY_H,
    desks: [],
  };
  pods.push(lobby);

  return { pods, desks, lobby, ...bounds() };
}

// ---------- Projection ----------

export interface Camera {
  /** Screen position (CSS px) of world origin. */
  ox: number;
  oy: number;
  zoom: number;
}

export function project(x: number, y: number, z: number, cam: Camera): [number, number] {
  return [
    cam.ox + ((x - y) * TILE_W * cam.zoom) / 2,
    cam.oy + ((x + y) * TILE_H * cam.zoom) / 2 - z * TILE_H * cam.zoom,
  ];
}

export function unproject(sx: number, sy: number, cam: Camera): [number, number] {
  const px = (sx - cam.ox) / ((TILE_W * cam.zoom) / 2);
  const py = (sy - cam.oy) / ((TILE_H * cam.zoom) / 2);
  return [(px + py) / 2, (py - px) / 2];
}

// ---------- Colour helpers ----------

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [148, 163, 184];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(rgb: [number, number, number], a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

/** Mix `rgb` toward white (`t` > 0) or black (`t` < 0). */
function shade(rgb: [number, number, number], t: number): [number, number, number] {
  const target = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  return [
    Math.round(rgb[0] + (target - rgb[0]) * k),
    Math.round(rgb[1] + (target - rgb[1]) * k),
    Math.round(rgb[2] + (target - rgb[2]) * k),
  ];
}

export interface Palette {
  dark: boolean;
  background: string;
  text: string;
  textMuted: string;
  surface: string;
  border: string;
  success: string;
  danger: string;
  brand: string;
}

// ---------- Renderer ----------

export interface HoverTarget {
  kind: "agent" | "pod";
  slug: string;
  /** Screen position (CSS px) to anchor a tooltip. */
  sx: number;
  sy: number;
}

export interface RenderStats {
  running: number;
  doneToday: number;
}

type StatusFn = (slug: string) => DeskStatus;

interface Drawable {
  depth: number;
  draw: () => void;
}

/** A department name tag with its screen rectangle. */
interface PodTag {
  pod: Pod;
  text: string;
  working: number;
  pointed: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export class OfficeRenderer {
  readonly cam: Camera = { ox: 0, oy: 0, zoom: 1 };
  layout: Layout | null = null;
  palette: Palette;
  status: StatusFn = () => "idle";
  hovered: HoverTarget | null = null;
  selectedAgent: string | null = null;
  selectedPod: string | null = null;
  stats: RenderStats = { running: 0, doneToday: 0 };

  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** Agent screen anchors from the last frame, for hit-testing. */
  private anchors: { slug: string; sx: number; sy: number; r: number }[] = [];
  /** Department tags that will be drawn this frame, placed before anything else so fixtures can keep clear. */
  private podTags: PodTag[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    palette: Palette,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unsupported");
    this.ctx = ctx;
    this.palette = palette;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  /** The camera that centres a world rect (in tiles) in the viewport. */
  private frame(minX: number, minY: number, maxX: number, maxY: number, padding: number, maxZoom: number): Camera | null {
    if (this.width === 0 || this.height === 0) return null;
    // Project the four world corners at zoom 1 to measure the footprint.
    const unit: Camera = { ox: 0, oy: 0, zoom: 1 };
    const corners = [
      project(minX, minY, 0, unit),
      project(maxX, minY, 0, unit),
      project(minX, maxY, 0, unit),
      project(maxX, maxY, 0, unit),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys) + TILE_H * 2.5; // walls + labels
    const zoom = Math.max(0.15, Math.min(maxZoom, (this.width - padding * 2) / w, (this.height - padding * 2) / h));
    const cx = ((Math.max(...xs) + Math.min(...xs)) / 2) * zoom;
    const cy = ((Math.max(...ys) + Math.min(...ys)) / 2) * zoom - TILE_H * zoom;
    return { zoom, ox: this.width / 2 - cx, oy: this.height / 2 - cy };
  }

  /** Centre the whole office in the viewport. */
  fit(padding = 40): void {
    const l = this.layout;
    if (!l) return;
    const cam = this.frame(l.minX, l.minY, l.maxX, l.maxY, padding, 1.6);
    if (cam) Object.assign(this.cam, cam);
  }

  /**
   * Director's camera, for a view nobody is steering: ease toward the desks
   * in `slugs` (the ones at work), or back out to the whole floor when the
   * list is empty. Call once a frame with the frame time in seconds; `snap`
   * jumps straight there (first frame, resize, new layout).
   */
  follow(slugs: readonly string[], dt: number, snap = false, padding = 14): void {
    const l = this.layout;
    if (!l) return;
    let target: Camera | null = null;
    const desks = slugs.length > 0 ? l.desks.filter((d) => slugs.includes(d.agent.slug)) : [];
    if (desks.length > 0) {
      const margin = 2.5; // tiles of context around the working desks
      target = this.frame(
        Math.min(...desks.map((d) => d.cx)) - margin,
        Math.min(...desks.map((d) => d.cy)) - margin,
        Math.max(...desks.map((d) => d.cx + CELL_W)) + margin,
        Math.max(...desks.map((d) => d.cy + CELL_D)) + margin,
        padding,
        1.05,
      );
    }
    target ??= this.frame(l.minX, l.minY, l.maxX, l.maxY, padding, 1.6);
    if (!target) return;
    if (snap) {
      Object.assign(this.cam, target);
      return;
    }
    // Ease the point under the viewport centre (in world space) and the zoom
    // (in log space) separately, so the move reads as one glide rather than
    // a swing.
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 2.4);
    const mx = this.width / 2;
    const my = this.height / 2;
    const [fx, fy] = unproject(mx, my, this.cam);
    const [tx, ty] = unproject(mx, my, target);
    const zoom = Math.exp(Math.log(this.cam.zoom) + (Math.log(target.zoom) - Math.log(this.cam.zoom)) * k);
    const [px, py] = project(fx + (tx - fx) * k, fy + (ty - fy) * k, 0, { ox: 0, oy: 0, zoom });
    this.cam.zoom = zoom;
    this.cam.ox = mx - px;
    this.cam.oy = my - py;
  }

  /**
   * The opening view: the whole office if it fits at a readable scale,
   * otherwise a closer look at the middle of the floor (the user pans).
   */
  home(minZoom = 0.5): void {
    this.fit();
    if (this.cam.zoom < minZoom) {
      this.zoomAt(this.width / 2, this.height / 2, minZoom / this.cam.zoom);
    }
  }

  /** Pan so a pod sits in the middle of the viewport. */
  focusPod(slug: string): void {
    const p = this.layout?.pods.find((x) => x.slug === slug);
    if (!p) return;
    const [sx, sy] = project(p.x + p.w / 2, p.y + p.h / 2, 0, this.cam);
    this.cam.ox += this.width / 2 - sx;
    this.cam.oy += this.height / 2 - sy;
  }

  pan(dx: number, dy: number): void {
    this.cam.ox += dx;
    this.cam.oy += dy;
  }

  /** Zoom about a screen point. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const next = Math.max(0.15, Math.min(3, this.cam.zoom * factor));
    const k = next / this.cam.zoom;
    this.cam.ox = sx - (sx - this.cam.ox) * k;
    this.cam.oy = sy - (sy - this.cam.oy) * k;
    this.cam.zoom = next;
  }

  /** What is under a screen point: an agent (desk) first, else a pod. */
  hitTest(sx: number, sy: number): HoverTarget | null {
    let best: HoverTarget | null = null;
    let bestD = Infinity;
    for (const a of this.anchors) {
      const d = Math.hypot(a.sx - sx, a.sy - sy);
      if (d < a.r && d < bestD) {
        bestD = d;
        best = { kind: "agent", slug: a.slug, sx: a.sx, sy: a.sy };
      }
    }
    if (best) return best;
    const [wx, wy] = unproject(sx, sy, this.cam);
    for (const p of this.layout?.pods ?? []) {
      if (wx >= p.x && wx < p.x + p.w && wy >= p.y && wy < p.y + p.h) {
        const [px, py] = project(p.x, p.y, 0, this.cam);
        return { kind: "pod", slug: p.slug, sx: px, sy: py };
      }
    }
    return null;
  }

  // ---------- Frame ----------

  render(t: number): void {
    const { ctx, palette } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, this.width, this.height);
    this.anchors = [];
    const l = this.layout;
    if (!l) return;

    this.drawGrid();
    this.podTags = this.placePodLabels(l.pods);

    // Floors and back walls first (flat), then everything that stands.
    for (const p of l.pods) this.drawFloor(p);
    for (const p of l.pods) this.drawWalls(p);

    const items: Drawable[] = [];
    for (const p of l.pods) {
      if (p.kind === "lobby") {
        items.push({ depth: p.x + p.y + 2, draw: () => this.drawLobby(p, t) });
        continue;
      }
      for (const d of p.desks) {
        const status = this.status(d.agent.slug);
        items.push({ depth: d.cx + d.cy + 1.2, draw: () => this.drawDesk(d, status, t) });
      }
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) it.draw();

    this.drawPodLabels();
    this.drawHoverTag();
  }

  // ---------- Pieces ----------

  private tilePath(x: number, y: number, w: number, h: number, z = 0): void {
    const { ctx, cam } = this;
    const a = project(x, y, z, cam);
    const b = project(x + w, y, z, cam);
    const c = project(x + w, y + h, z, cam);
    const d = project(x, y + h, z, cam);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
  }

  /** An axis-aligned box standing on the floor: top, left and right faces. */
  private box(x: number, y: number, w: number, h: number, z0: number, height: number, rgb: [number, number, number], alpha = 1): void {
    const { ctx, cam } = this;
    const top = shade(rgb, this.palette.dark ? 0.12 : 0.25);
    const left = shade(rgb, -0.18);
    const right = shade(rgb, -0.36);
    const z1 = z0 + height;
    // Left face (x = x, along y)
    const a = project(x, y, z1, cam);
    const b = project(x, y + h, z1, cam);
    const c = project(x, y + h, z0, cam);
    const d = project(x, y, z0, cam);
    ctx.fillStyle = rgba(left, alpha);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    // Right face (y = y + h, along x)
    const e = project(x + w, y + h, z1, cam);
    const f = project(x + w, y + h, z0, cam);
    ctx.fillStyle = rgba(right, alpha);
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.lineTo(f[0], f[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.closePath();
    ctx.fill();
    // Top
    ctx.fillStyle = rgba(top, alpha);
    this.tilePath(x, y, w, h, z1);
    ctx.fill();
  }

  private drawGrid(): void {
    const { ctx, cam, palette } = this;
    if (cam.zoom < 0.5) return;
    const l = this.layout!;
    ctx.strokeStyle = palette.dark ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.045)";
    ctx.lineWidth = 1;
    const pad = 6;
    for (let x = l.minX - pad; x <= l.maxX + pad; x++) {
      const a = project(x, l.minY - pad, 0, cam);
      const b = project(x, l.maxY + pad, 0, cam);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (let y = l.minY - pad; y <= l.maxY + pad; y++) {
      const a = project(l.minX - pad, y, 0, cam);
      const b = project(l.maxX + pad, y, 0, cam);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  private drawFloor(p: Pod): void {
    const { ctx, palette } = this;
    const rgb = hexToRgb(p.color);
    const selected = this.selectedPod === p.slug;
    const hovered = this.hovered?.kind === "pod" && this.hovered.slug === p.slug;
    const tint = palette.dark ? 0.1 : 0.16;
    // Carpet
    ctx.fillStyle = palette.dark ? rgba(shade(rgb, -0.62), 1) : rgba(shade(rgb, 0.82), 1);
    this.tilePath(p.x, p.y, p.w, p.h);
    ctx.fill();
    // Rug band inside the margin
    ctx.fillStyle = rgba(rgb, selected || hovered ? tint + 0.1 : tint);
    this.tilePath(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    ctx.fill();
    // Edge
    ctx.strokeStyle = rgba(rgb, selected ? 0.9 : 0.45);
    ctx.lineWidth = selected ? 2 : 1;
    this.tilePath(p.x, p.y, p.w, p.h);
    ctx.stroke();
  }

  /** Low glass partitions along the two back edges of a pod. */
  private drawWalls(p: Pod): void {
    const { ctx, cam, palette } = this;
    const rgb = hexToRgb(p.color);
    const wallH = 0.9;
    const fill = palette.dark ? rgba(shade(rgb, 0.1), 0.16) : rgba(shade(rgb, -0.1), 0.12);
    const edge = rgba(rgb, 0.55);
    // Back-left wall: x = p.x, y from p.y to p.y + p.h
    let a = project(p.x, p.y, wallH, cam);
    let b = project(p.x, p.y + p.h, wallH, cam);
    let c = project(p.x, p.y + p.h, 0, cam);
    let d = project(p.x, p.y, 0, cam);
    ctx.fillStyle = fill;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Back-right wall: y = p.y, x from p.x to p.x + p.w
    a = project(p.x, p.y, wallH, cam);
    b = project(p.x + p.w, p.y, wallH, cam);
    c = project(p.x + p.w, p.y, 0, cam);
    d = project(p.x, p.y, 0, cam);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawDesk(d: Desk, status: DeskStatus, t: number): void {
    const { ctx, cam, palette } = this;
    const z = cam.zoom;
    const rgb = hexToRgb(d.pod.color);
    const working = status === "working";
    const isSel = this.selectedAgent === d.agent.slug;
    const isHov = this.hovered?.kind === "agent" && this.hovered.slug === d.agent.slug;

    // Geometry inside the 2×2 cell: agent sits at the back (small y), desk in
    // front of them, chair behind them.
    const deskX = d.cx + 0.3;
    const deskY = d.cy + 1.05;
    const deskW = 1.4;
    const deskD = 0.6;
    const deskH = 0.42;
    const seatX = d.cx + 1.0;
    const seatY = d.cy + 0.6;

    // Selection / hover halo on the floor
    if (isSel || isHov) {
      ctx.fillStyle = rgba(rgb, isSel ? 0.35 : 0.2);
      this.tilePath(d.cx + 0.1, d.cy + 0.05, 1.8, 1.7);
      ctx.fill();
    }

    // Screen glow on the floor and desk while working
    if (working) {
      const pulse = 0.55 + 0.25 * Math.sin(t / 380 + d.phase * 6.28);
      const [gx, gy] = project(seatX, deskY - 0.1, 0.2, cam);
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 34 * z);
      grad.addColorStop(0, `rgba(120,200,255,${0.32 * pulse})`);
      grad.addColorStop(1, "rgba(120,200,255,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(gx, gy, 38 * z, 22 * z, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chair (behind the agent)
    const chairRgb: [number, number, number] = palette.dark ? [70, 74, 84] : [96, 100, 110];
    this.box(seatX - 0.26, seatY - 0.42, 0.52, 0.12, 0, 0.75, chairRgb); // back rest
    this.box(seatX - 0.26, seatY - 0.32, 0.52, 0.45, 0, 0.3, chairRgb); // seat

    // Person
    this.drawPerson(seatX, seatY, rgb, status, t, d.phase);

    // Desk (in front of the person, drawn after so it overlaps their lap)
    const deskRgb: [number, number, number] = palette.dark ? [150, 128, 104] : [214, 196, 170];
    this.box(deskX, deskY, deskW, deskD, 0, deskH, deskRgb);

    // Monitor on the desk: a thin slab facing the person, plus a stand.
    const monX = seatX - 0.22;
    const monY = deskY + 0.14;
    const monRgb: [number, number, number] = palette.dark ? [40, 42, 48] : [52, 54, 60];
    this.box(monX + 0.17, monY + 0.08, 0.1, 0.1, deskH, 0.12, monRgb); // stand
    this.box(monX, monY, 0.44, 0.08, deskH + 0.12, 0.34, monRgb); // panel
    // Screen face (the side toward the person = the back face from our view);
    // we hint the display with a glowing top edge when working.
    if (working) {
      const [sx, sy] = project(monX + 0.22, monY, deskH + 0.46, cam);
      ctx.fillStyle = `rgba(140,210,255,${0.6 + 0.3 * Math.sin(t / 300 + d.phase * 6)})`;
      ctx.beginPath();
      ctx.ellipse(sx, sy, 12 * z, 3 * z, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Small keyboard
    this.box(seatX - 0.18, deskY + 0.32, 0.36, 0.12, deskH, 0.03, palette.dark ? [90, 92, 100] : [120, 124, 132]);

    // Status bubble above the head
    const [hx, hy] = project(seatX, seatY, 1.45, cam);
    this.anchors.push({ slug: d.agent.slug, sx: hx, sy: hy + 10 * z, r: Math.max(14, 16 * z) });
    if (status !== "idle") this.drawBubble(hx, hy - 6 * z, status, t, d.phase);

    // Name tag at high zoom (hover/selection tags are drawn last, on top)
    if (z >= 1.35 && !isHov && !isSel) {
      const [nx, ny] = project(seatX, deskY + deskD, deskH, cam);
      this.label(d.agent.name, nx, ny + 10 * z, 10, palette.textMuted, "center");
    }
  }

  private drawPerson(x: number, y: number, shirt: [number, number, number], status: DeskStatus, t: number, phase: number): void {
    const { ctx, cam, palette } = this;
    const z = cam.zoom;
    const working = status === "working";
    const breathe = working ? 0 : Math.sin(t / 1400 + phase * 6.28) * 0.6;
    const typing = working ? Math.sin(t / 110 + phase * 6.28) : 0;

    const [bx, by] = project(x, y, 0.3, cam); // hip
    const skin = palette.dark ? "#e2b89a" : "#e8c3a4";
    const hair = ["#2b1d14", "#4a2f1a", "#1c1c1e", "#7a4b2a", "#c9a36a", "#3b3b3b"][Math.floor(phase * 6) % 6];

    // Torso
    const tw = 13 * z;
    const th = 15 * z;
    ctx.fillStyle = rgba(shirt, 1);
    roundRect(ctx, bx - tw / 2, by - th - breathe, tw, th, 4 * z);
    ctx.fill();
    // Shirt shading
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    roundRect(ctx, bx + 1 * z, by - th - breathe, tw / 2 - 1 * z, th, 4 * z);
    ctx.fill();

    // Arms (forward toward the desk; bob while typing)
    ctx.strokeStyle = rgba(shade(shirt, -0.15), 1);
    ctx.lineWidth = 3.2 * z;
    ctx.lineCap = "round";
    const armY = by - th * 0.55 - breathe;
    ctx.beginPath();
    ctx.moveTo(bx - tw / 2 + 1 * z, armY);
    ctx.lineTo(bx - tw / 2 - 2 * z, armY + 8 * z + typing * 1.2 * z);
    ctx.moveTo(bx + tw / 2 - 1 * z, armY);
    ctx.lineTo(bx + tw / 2 + 2 * z, armY + 8 * z - typing * 1.2 * z);
    ctx.stroke();
    // Hands
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(bx - tw / 2 - 2 * z, armY + 8 * z + typing * 1.2 * z, 2 * z, 0, Math.PI * 2);
    ctx.arc(bx + tw / 2 + 2 * z, armY + 8 * z - typing * 1.2 * z, 2 * z, 0, Math.PI * 2);
    ctx.fill();

    // Head
    const hr = 6 * z;
    const hy = by - th - hr - 1 * z - breathe;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(bx, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    // Screen light on the face while working
    if (working) {
      ctx.fillStyle = `rgba(140,210,255,${0.22 + 0.1 * Math.sin(t / 300 + phase * 6)})`;
      ctx.beginPath();
      ctx.arc(bx, hy + hr * 0.25, hr * 0.8, 0, Math.PI);
      ctx.fill();
    }
    // Hair cap
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.arc(bx, hy - hr * 0.15, hr * 0.98, Math.PI, Math.PI * 2);
    ctx.fill();
    // Eyes
    ctx.fillStyle = "#1f1f1f";
    ctx.beginPath();
    ctx.arc(bx - hr * 0.35, hy + hr * 0.1, 0.9 * z, 0, Math.PI * 2);
    ctx.arc(bx + hr * 0.35, hy + hr * 0.1, 0.9 * z, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBubble(x: number, y: number, status: DeskStatus, t: number, phase: number): void {
    const { ctx, palette } = this;
    const z = this.cam.zoom;
    const w = 26 * z;
    const h = 16 * z;
    const bg = status === "working" ? palette.surface : status === "done" ? palette.success : palette.danger;
    const fg = status === "working" ? palette.text : "#ffffff";
    ctx.fillStyle = bg;
    ctx.strokeStyle = status === "working" ? palette.border : bg;
    ctx.lineWidth = 1;
    roundRect(ctx, x - w / 2, y - h, w, h, 5 * z);
    ctx.fill();
    ctx.stroke();
    // Tail
    ctx.beginPath();
    ctx.moveTo(x - 3 * z, y);
    ctx.lineTo(x, y + 4 * z);
    ctx.lineTo(x + 3 * z, y);
    ctx.closePath();
    ctx.fill();
    if (status === "working") {
      const k = Math.floor(t / 320 + phase * 3) % 3;
      ctx.fillStyle = fg;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = i === k ? 1 : 0.35;
        ctx.beginPath();
        ctx.arc(x + (i - 1) * 6 * z, y - h / 2, 1.9 * z, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = fg;
      ctx.lineWidth = 2 * z;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (status === "done") {
        ctx.moveTo(x - 5 * z, y - h / 2);
        ctx.lineTo(x - 1.5 * z, y - h / 2 + 3.5 * z);
        ctx.lineTo(x + 5 * z, y - h / 2 - 4 * z);
      } else {
        ctx.moveTo(x, y - h + 4 * z);
        ctx.lineTo(x, y - h / 2 + 1 * z);
        ctx.moveTo(x, y - 4 * z);
        ctx.lineTo(x, y - 3.5 * z);
      }
      ctx.stroke();
    }
  }

  private drawLobby(p: Pod, t: number): void {
    const { ctx, cam, palette } = this;
    const z = cam.zoom;
    const rgb = hexToRgb(p.color);
    // Reception counter along the front
    const counterRgb: [number, number, number] = palette.dark ? [120, 96, 70] : [196, 170, 140];
    this.box(p.x + 1.2, p.y + p.h - 2.2, p.w - 2.4, 0.7, 0, 0.55, counterRgb);
    // Two plants in the back corners
    this.drawPlant(p.x + 0.9, p.y + 0.9);
    this.drawPlant(p.x + p.w - 0.9, p.y + 0.9);
    // Wall sign: agency name floating above the back-right wall. A department
    // tag that lands on it wins: the tag is the more useful of the two.
    const detailed = z >= 0.45;
    // Below this the task board is too small to carry two lines of text.
    const roomy = z >= 0.8;
    const live = this.stats.running;
    const pulse = live > 0 ? 0.75 + 0.25 * Math.sin(t / 500) : 1;
    const liveInk = live > 0 ? `rgba(120,200,255,${pulse})` : palette.textMuted;
    const font = (weight: number, px: number) => `${weight} ${px}px -apple-system, "Segoe UI", system-ui, sans-serif`;

    const [sx, sy] = project(p.x + p.w / 2, p.y + 0.6, 1.9, cam);
    const nameSize = Math.max(9, 20 * z);
    const subSize = Math.max(9, 10 * z);
    const name = p.label.toUpperCase();
    ctx.font = font(700, nameSize);
    const nameW = ctx.measureText(name).width;
    const covered = this.podTags.some(
      (tag) => tag.x < sx + nameW / 2 && sx - nameW / 2 < tag.x + tag.w && tag.y < sy + 2 && sy - nameSize < tag.y + tag.h,
    );
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (!covered) {
      ctx.fillStyle = rgba(rgb, 0.95);
      ctx.fillText(name, sx, sy);
      if (detailed) {
        // The second line sits a full line below the first whatever the zoom.
        ctx.font = font(500, subSize);
        ctx.fillStyle = roomy ? palette.textMuted : liveInk;
        const sub = roomy ? "HEADQUARTERS" : `${live} working · ${this.stats.doneToday} done today`;
        ctx.fillText(sub, sx, sy + subSize + 3);
      }
    }

    // Task board: a standing panel in the lobby with live counts.
    const bx = p.x + p.w / 2;
    const by = p.y + p.h / 2 + 0.2;
    const boardRgb: [number, number, number] = palette.dark ? [38, 40, 46] : [250, 250, 250];
    this.box(bx - 1.1, by, 2.2, 0.1, 0, 1.2, boardRgb);
    if (!roomy) return;
    const [tx, ty] = project(bx, by, 0.6, cam);
    const countSize = Math.max(10, 13 * z);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = font(700, countSize);
    ctx.fillStyle = liveInk;
    ctx.fillText(`${live} working`, tx, ty - 2);
    ctx.font = font(500, subSize);
    ctx.fillStyle = palette.textMuted;
    ctx.fillText(`${this.stats.doneToday} done today`, tx, ty + subSize + 1);
  }

  private drawPlant(x: number, y: number): void {
    const { ctx, cam, palette } = this;
    const z = cam.zoom;
    this.box(x - 0.18, y - 0.18, 0.36, 0.36, 0, 0.35, palette.dark ? [110, 80, 60] : [160, 120, 90]);
    const [px, py] = project(x, y, 0.35, cam);
    ctx.fillStyle = palette.dark ? "#3f8f5a" : "#4caf6e";
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(px + Math.cos(ang) * 5 * z, py - 6 * z + Math.sin(ang) * 3 * z, 5 * z, 3 * z, ang, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Department name tags. When the floor is small on screen the tags are
   * wider than the pods they name, so they are placed in order of interest
   * (the pod under the pointer, then pods with work running, then the biggest)
   * and a tag that would cover one already placed is left out.
   */
  private placePodLabels(pods: readonly Pod[]): PodTag[] {
    const { ctx, cam } = this;
    const z = cam.zoom;
    const compact = z < 0.45;
    const size = compact ? 9 : Math.max(10, 12 * Math.min(1.2, z));
    ctx.font = `600 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    const h = size + 10;

    const tags = pods
      .filter((p) => p.kind !== "lobby")
      .map((p): PodTag => {
        let working = 0;
        for (const d of p.desks) if (this.status(d.agent.slug) === "working") working++;
        const text = compact
          ? `${p.label}${working ? ` · ${working}` : ""}`
          : `${p.label}  ·  ${p.desks.length}${working ? `  ·  ${working} working` : ""}`;
        const [sx, sy] = project(p.x + p.w / 2, p.y, 1.0, cam);
        const w = ctx.measureText(text).width + 22;
        const pointed = this.hovered?.kind === "pod" && this.hovered.slug === p.slug;
        return { pod: p, text, working, pointed, x: sx - w / 2, y: sy - h / 2 - 4, w, h, cx: sx, cy: sy - 4 };
      })
      .sort(
        (a, b) =>
          Number(b.pointed) - Number(a.pointed) || b.working - a.working || b.pod.desks.length - a.pod.desks.length,
      );

    const gap = 3;
    const placed: PodTag[] = [];
    for (const tag of tags) {
      const covers = placed.some(
        (o) => tag.x < o.x + o.w + gap && o.x < tag.x + tag.w + gap && tag.y < o.y + h + gap && o.y < tag.y + h + gap,
      );
      if (!covers) placed.push(tag);
    }
    return placed;
  }

  private drawPodLabels(): void {
    const { ctx, palette } = this;
    const first = this.podTags[0];
    if (!first) return;
    ctx.font = `600 ${first.h - 10}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const tag of this.podTags) {
      ctx.fillStyle = palette.dark ? "rgba(20,20,24,0.82)" : "rgba(255,255,255,0.88)";
      ctx.strokeStyle = rgba(hexToRgb(tag.pod.color), 0.6);
      roundRect(ctx, tag.x, tag.y, tag.w, tag.h, tag.h / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = tag.pod.color;
      ctx.beginPath();
      ctx.arc(tag.x + 10, tag.cy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.text;
      ctx.fillText(tag.text, tag.cx + 5, tag.cy);
    }
  }

  private drawHoverTag(): void {
    const h = this.hovered;
    const l = this.layout;
    if (!h || !l) return;
    if (h.kind === "agent") {
      const d = l.desks.find((x) => x.agent.slug === h.slug);
      if (!d) return;
      const status = this.status(h.slug);
      const a = this.anchors.find((x) => x.slug === h.slug);
      if (!a) return;
      const title = `${d.agent.emoji ? d.agent.emoji + " " : ""}${d.agent.name}`;
      const sub = `${d.pod.label} · ${status}`;
      this.tag(title, sub, a.sx, a.sy - 34 * this.cam.zoom, d.pod.color);
    }
  }

  private tag(title: string, sub: string, x: number, y: number, color: string): void {
    const { ctx, palette } = this;
    ctx.font = `600 12px -apple-system, "Segoe UI", system-ui, sans-serif`;
    const w1 = ctx.measureText(title).width;
    ctx.font = `500 10px -apple-system, "Segoe UI", system-ui, sans-serif`;
    const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 20;
    const h = 36;
    const bx = Math.min(Math.max(x - w / 2, 6), this.width - w - 6);
    const by = Math.max(y - h, 6);
    ctx.fillStyle = palette.dark ? "rgba(24,24,28,0.94)" : "rgba(255,255,255,0.96)";
    ctx.strokeStyle = rgba(hexToRgb(color), 0.7);
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, w, h, 7);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = palette.text;
    ctx.font = `600 12px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(title, bx + 10, by + 15);
    ctx.fillStyle = palette.textMuted;
    ctx.font = `500 10px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(sub, bx + 10, by + 28);
  }

  private label(text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign): void {
    const { ctx } = this;
    ctx.font = `500 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
