<script lang="ts">
  /**
   * The Oz Agency mark: an isometric block with a ring set into its top face.
   * Same geometry as tools/brand/icon.svg, without the plate, so it sits
   * directly on any app surface. Fills come from the theme tokens.
   */
  interface Props {
    /** Rendered height in px; width follows the 13:15 aspect ratio. */
    size?: number;
    /** Accessible name. Omit when the mark sits next to the written name. */
    label?: string;
  }
  let { size = 20, label }: Props = $props();
</script>

<svg
  class="mark"
  viewBox="0 0 520 600"
  width={(size * 520) / 600}
  height={size}
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  <path class="left" d="M0 150 L260 300 L260 600 L0 450 Z" />
  <path class="right" d="M520 150 L260 300 L260 600 L520 450 Z" />
  <path class="top" d="M260 0 L520 150 L260 300 L0 150 Z" />
  <path
    class="ring"
    fill-rule="evenodd"
    d="M122 150 A138 79.7 0 1 0 398 150 A138 79.7 0 1 0 122 150 Z
       M184 150 A76 43.9 0 1 0 336 150 A76 43.9 0 1 0 184 150 Z"
  />
</svg>

<style>
  .mark {
    flex: none;
    display: block;
    --mark-top: oklch(90% 0.07 68);
    --mark-left: var(--color-brand);
    --mark-right: oklch(44% 0.11 42);
    --mark-ring: var(--color-brand-active);
  }
  :global([data-theme="dark"]) .mark {
    --mark-top: oklch(94% 0.05 78);
    --mark-left: var(--color-brand);
    --mark-right: oklch(50% 0.13 42);
    --mark-ring: oklch(60% 0.16 45);
  }
  .top { fill: var(--mark-top); }
  .left { fill: var(--mark-left); }
  .right { fill: var(--mark-right); }
  .ring { fill: var(--mark-ring); }
</style>
