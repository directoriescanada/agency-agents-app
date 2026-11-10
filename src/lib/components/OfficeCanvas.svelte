<script lang="ts">
  /**
   * OfficeCanvas — hosts the isometric office renderer (`$lib/office/scene`).
   *
   * Owns the <canvas>, the resize observer, the animation loop and pointer
   * handling (drag to pan, wheel to zoom, hover and click to pick desks or
   * pods). Catalog shape and live statuses come in as props; picks go out
   * as callbacks. The renderer itself is framework-free.
   *
   * With `interactive={false}` it becomes a window onto the office: nobody
   * steers, the camera frames whoever is working (or the whole floor), and
   * a click anywhere calls `onEnter`.
   */
  import { onMount } from "svelte";
  import { office } from "$lib/stores/office.svelte";
  import { ui } from "$lib/stores/ui.svelte";
  import {
    OfficeRenderer,
    buildLayout,
    type HoverTarget,
    type Palette,
    type SceneDepartment,
  } from "$lib/office/scene";

  interface Props {
    departments: SceneDepartment[];
    agencyName: string;
    selectedAgent?: string | null;
    selectedPod?: string | null;
    onPickAgent?: (slug: string) => void;
    onPickPod?: (slug: string) => void;
    onPickNothing?: () => void;
    /** `false`: no pan, zoom or picking; the camera directs itself. */
    interactive?: boolean;
    /** Non-interactive only: the view was clicked (or activated by keyboard). */
    onEnter?: () => void;
    /** Non-interactive only: accessible name of the click target. */
    enterLabel?: string;
  }
  let {
    departments,
    agencyName,
    selectedAgent = null,
    selectedPod = null,
    onPickAgent,
    onPickPod,
    onPickNothing,
    interactive = true,
    onEnter,
    enterLabel,
  }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let renderer: OfficeRenderer | null = null;
  let hovered: HoverTarget | null = $state(null);
  let cursor = $state("grab");

  function readPalette(): Palette {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.dataset.theme === "dark";
    return {
      dark,
      background: v("--color-surface-sunken", dark ? "#15151a" : "#f4f4f1"),
      text: v("--color-text-primary", dark ? "#eee" : "#222"),
      textMuted: v("--color-text-muted", dark ? "#999" : "#666"),
      surface: v("--color-surface-raised", dark ? "#2a2a30" : "#fff"),
      border: v("--color-border-strong", dark ? "#555" : "#ccc"),
      success: v("--color-success", "#22a06b"),
      danger: v("--color-danger", "#d03a2a"),
      brand: v("--color-brand", "#d97706"),
    };
  }

  /** Once the user pans or zooms, resizes and roster changes stop re-fitting. */
  let userMoved = false;
  /** Non-interactive: jump the camera to its target on the next frame. */
  let snap = true;

  // Rebuild the layout when the roster changes (not on every status tick).
  $effect(() => {
    const deps = departments;
    const name = agencyName;
    if (!renderer) return;
    renderer.layout = buildLayout(deps, name);
    snap = true;
    if (interactive && !userMoved) renderer.home();
  });

  $effect(() => {
    if (!renderer) return;
    renderer.selectedAgent = selectedAgent;
    renderer.selectedPod = selectedPod;
  });

  // Theme flips re-read the palette.
  $effect(() => {
    void ui.theme;
    if (renderer) renderer.palette = readPalette();
  });

  onMount(() => {
    if (!host || !canvas) return;
    const hostEl = host;
    renderer = new OfficeRenderer(canvas, readPalette());
    renderer.status = (slug) => office.deskStatus(slug);
    renderer.layout = buildLayout(departments, agencyName);

    const ro = new ResizeObserver(() => {
      const r = hostEl.getBoundingClientRect();
      renderer?.resize(r.width, r.height, window.devicePixelRatio || 1);
      snap = true;
      if (interactive && !userMoved && r.width > 0) renderer?.home();
    });
    ro.observe(hostEl);

    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      if (renderer) {
        if (!interactive) {
          renderer.follow(
            office.running.map((x) => x.agentSlug),
            dt,
            snap,
          );
          snap = false;
        }
        const today = new Date().toDateString();
        renderer.stats = {
          running: office.running.length,
          doneToday: office.tasks.filter((x) => x.status === "done" && x.finishedAt && new Date(x.finishedAt).toDateString() === today).length,
        };
        renderer.render(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const mo = new MutationObserver(() => {
      if (renderer) renderer.palette = readPalette();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      renderer = null;
    };
  });

  // ---------- Pointer ----------
  let dragging = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  function local(e: PointerEvent | WheelEvent): [number, number] {
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    moved = 0;
    [lastX, lastY] = local(e);
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    cursor = "grabbing";
  }

  function onPointerMove(e: PointerEvent) {
    const [x, y] = local(e);
    if (dragging) {
      const dx = x - lastX;
      const dy = y - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6) userMoved = true;
      renderer?.pan(dx, dy);
      lastX = x;
      lastY = y;
      return;
    }
    const h = renderer?.hitTest(x, y) ?? null;
    hovered = h;
    if (renderer) renderer.hovered = h;
    cursor = h ? "pointer" : "grab";
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    cursor = hovered ? "pointer" : "grab";
    (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    if (moved > 6) return; // a drag, not a click
    const [x, y] = local(e);
    const h = renderer?.hitTest(x, y) ?? null;
    if (!h) onPickNothing?.();
    else if (h.kind === "agent") onPickAgent?.(h.slug);
    else onPickPod?.(h.slug);
  }

  function onPointerLeave() {
    hovered = null;
    if (renderer) renderer.hovered = null;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    userMoved = true;
    const [x, y] = local(e);
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 3) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      renderer?.zoomAt(x, y, factor);
    } else {
      renderer?.pan(-e.deltaX, -e.deltaY);
    }
  }

  function onEnterKey(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onEnter?.();
  }

  export function fit() {
    userMoved = false;
    renderer?.fit();
  }
  export function focusPod(slug: string) {
    userMoved = true;
    renderer?.focusPod(slug);
  }
  export function zoomBy(factor: number) {
    userMoved = true;
    if (!host) return;
    const r = host.getBoundingClientRect();
    renderer?.zoomAt(r.width / 2, r.height / 2, factor);
  }
</script>

{#if interactive}
  <div class="host" bind:this={host}>
    <canvas
      bind:this={canvas}
      style="cursor: {cursor}"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onpointerleave={onPointerLeave}
      onwheel={onWheel}
      aria-label="Isometric office"
    ></canvas>
  </div>
{:else}
  <div
    class="host enter"
    bind:this={host}
    role="button"
    tabindex="0"
    aria-label={enterLabel}
    onclick={() => onEnter?.()}
    onkeydown={onEnterKey}
  >
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
  </div>
{/if}

<style>
  .host {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--color-surface-sunken);
  }
  .host.enter { cursor: pointer; }
  .host.enter:focus-visible { outline: 2px solid var(--color-border-focus); outline-offset: -2px; }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    user-select: none;
  }
</style>
