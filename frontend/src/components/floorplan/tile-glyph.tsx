import { getLucideIcon } from "@/components/dynamic-icon"

// The plan's icons as one sprite: each Lucide icon a tile draws is defined
// once, as a <symbol> in the canvas's <defs>, and every tile that wears it
// is a <use> of it - hundreds of racks cost one path set, not hundreds.

/** Lucide's own stroke, a touch heavier so a small glyph holds up. */
export const GLYPH_STROKE = 2.25

/** A symbol's id for an icon under the sprite's `prefix`. */
export function glyphId(prefix: string, name: string): string {
  return `${prefix}-${name}`
}

/** An id safe in `href="#…"` and `url(#…)` from React's useId (":r1:"). */
export function spritePrefix(raw: string): string {
  return `tg${raw.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/** A canvas's sprite: its ids' prefix and the icons it holds. */
export interface GlyphSheet {
  prefix: string
  names: ReadonlySet<string>
}

/** The icons under `prefix`, as symbols - inside an <svg>'s <defs>. */
export function GlyphSprite({
  prefix,
  names,
}: {
  prefix: string
  names: Iterable<string>
}) {
  const out: React.ReactNode[] = []
  for (const name of names) {
    const Icon = getLucideIcon(name)
    if (!Icon) continue
    out.push(
      <symbol
        key={name}
        id={glyphId(prefix, name)}
        viewBox="0 0 24 24"
        overflow="visible"
      >
        <Icon width={24} height={24} strokeWidth={GLYPH_STROKE} />
      </symbol>
    )
  }
  return <>{out}</>
}

/**
 * One icon on the plan at (x, y), `size` square, in `color`: a <use> of
 * the sprite when the canvas holds it, else the icon itself (a tile drawn
 * outside a canvas, a name the sprite has not caught up with).
 */
export function TileGlyph({
  name,
  x,
  y,
  size,
  color,
  part,
  sheet,
}: {
  name: string
  x: number
  y: number
  size: number
  color: string
  /** Its `data-part`, for tests and the export's parity check. */
  part: string
  /** The canvas's sprite, when it has one. */
  sheet?: GlyphSheet | null
}) {
  const sprite = sheet
  if (sprite?.names.has(name))
    return (
      <use
        href={`#${glyphId(sprite.prefix, name)}`}
        data-part={part}
        data-icon={name}
        x={x}
        y={y}
        width={size}
        height={size}
        color={color}
        pointerEvents="none"
        aria-hidden="true"
      />
    )
  const Icon = name ? getLucideIcon(name) : null
  if (!Icon) return null
  return (
    <Icon
      data-part={part}
      data-icon={name}
      x={x}
      y={y}
      width={size}
      height={size}
      color={color}
      strokeWidth={GLYPH_STROKE}
      pointerEvents="none"
      aria-hidden="true"
    />
  )
}
