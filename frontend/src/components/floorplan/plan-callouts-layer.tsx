import { readableText } from "@/lib/color"
import { cssColor } from "@/lib/utils"

import { CELL } from "./canvas-geometry"
import {
  CALLOUT_ACCENT_PX,
  CALLOUT_FONT_PX,
  CALLOUT_LINE_FONT_PX,
  CALLOUT_LINE_PX,
  CALLOUT_PAD_X,
  CALLOUT_PAD_Y,
  CALLOUT_TAB_PX,
  calloutValue,
} from "./plan-callouts"
import type { CalloutSide } from "./plan-callouts"
import type { CalloutLabel } from "./plan-label-pass"

/** The box's pointer tab (px): its width along the edge and its depth. */
const TAB_W = 10
const TAB_H = CALLOUT_TAB_PX
const RADIUS = 5

/** The box's outline (px, about its centre): a rounded rectangle with a
 * small tab at the middle of the edge facing its tile. */
export function calloutPath(w: number, h: number, side: CalloutSide): string {
  const x0 = -w / 2
  const y0 = -h / 2
  const x1 = w / 2
  const y1 = h / 2
  const r = RADIUS
  const t = TAB_W / 2
  const d = TAB_H
  return [
    `M${x0 + r},${y0}`,
    side === "bottom" ? `L${-t},${y0} L0,${y0 - d} L${t},${y0}` : "",
    `L${x1 - r},${y0} Q${x1},${y0} ${x1},${y0 + r}`,
    side === "left" ? `L${x1},${-t} L${x1 + d},0 L${x1},${t}` : "",
    `L${x1},${y1 - r} Q${x1},${y1} ${x1 - r},${y1}`,
    side === "top" ? `L${t},${y1} L0,${y1 + d} L${-t},${y1}` : "",
    `L${x0 + r},${y1} Q${x0},${y1} ${x0},${y1 - r}`,
    side === "right" ? `L${x0},${t} L${x0 - d},0 L${x0},${-t}` : "",
    `L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} Z`,
  ]
    .filter(Boolean)
    .join(" ")
}

/** The tip of the box's tab (px, about its centre). */
function tabTip(w: number, h: number, side: CalloutSide): [number, number] {
  switch (side) {
    case "top":
      return [0, h / 2 + TAB_H]
    case "bottom":
      return [0, -h / 2 - TAB_H]
    case "left":
      return [w / 2 + TAB_H, 0]
    case "right":
      return [-w / 2 - TAB_H, 0]
  }
}

/**
 * The callouts the label pass placed (plan-callouts.ts): each a small box
 * at a constant size on screen (`k`, the zoom now) with the tile's name
 * and the lines its panel layout chose - a status or role as its badge -
 * an accent in the tile's colour down its left edge, and a leader from a
 * tab on the box to a dot on the tile: a solid line in the foreground
 * colour on a casing of the background, so it reads over a map, a photo
 * or a dark plan. A callout answers the pointer as its tile does:
 * hovering either lights the pair - a thicker leader in the accent colour
 * - and dims the other callouts; a press opens the tile.
 */
export function PlanCalloutsLayer({
  callouts,
  k,
  hot,
  selected,
  colorOf,
  onHover,
  onPress,
}: {
  callouts: readonly CalloutLabel[]
  k: number
  /** The tile hovered (here or on the plan): its callout lit. */
  hot: string | null
  /** The selection: its callouts lit. */
  selected?: ReadonlySet<string>
  /** The tile's colour, as its symbol is drawn: the box's accent. */
  colorOf?: (id: string) => string | undefined
  onHover?: (id: string | null) => void
  onPress?: (id: string, e: React.PointerEvent) => void
}) {
  if (!callouts.length) return null
  const s = 1 / k
  const isLit = (id: string) => id === hot || !!selected?.has(id)
  // One hovered: the rest step back.
  const focus = !!hot && callouts.some((c) => c.id === hot)
  // Lit last, over the rest.
  const order = [...callouts].sort(
    (a, b) => Number(isLit(a.id)) - Number(isLit(b.id))
  )
  const handlers = (id: string) => ({
    onPointerEnter: () => onHover?.(id),
    onPointerLeave: () => onHover?.(null),
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      onPress?.(id, e)
    },
  })
  const geo = order.map((c) => {
    const cx = c.at[0] * CELL
    const cy = c.at[1] * CELL
    const [tx, ty] = tabTip(c.size.w, c.size.h, c.side)
    return {
      c,
      cx,
      cy,
      lit: isLit(c.id),
      dim: focus && c.id !== hot,
      from: [cx + tx * s, cy + ty * s] as [number, number],
      to: [c.leader[1][0] * CELL, c.leader[1][1] * CELL] as [number, number],
    }
  })
  return (
    <g data-layer="callouts">
      {/* The leaders under the boxes: casing, line, the dot on the tile. */}
      <g data-part="leaders">
        {geo.map(({ c, lit, dim, from, to }) => (
          <g
            key={c.id}
            data-callout-leader={c.id}
            data-lit={lit ? "" : undefined}
            opacity={dim ? 0.3 : 1}
            className="cursor-pointer"
            {...handlers(c.id)}
          >
            <line
              data-part="casing"
              x1={from[0]}
              y1={from[1]}
              x2={to[0]}
              y2={to[1]}
              stroke="var(--background)"
              strokeWidth={(lit ? 6 : 4.5) * s}
              strokeLinecap="round"
            />
            <line
              data-part="leader"
              x1={from[0]}
              y1={from[1]}
              x2={to[0]}
              y2={to[1]}
              stroke={lit ? "var(--primary)" : "var(--foreground)"}
              strokeWidth={(lit ? 2.75 : 1.75) * s}
              strokeLinecap="round"
            />
            <circle
              data-part="anchor"
              cx={to[0]}
              cy={to[1]}
              r={(lit ? 4 : 3.25) * s}
              fill={lit ? "var(--primary)" : "var(--foreground)"}
              stroke="var(--background)"
              strokeWidth={1.5 * s}
            />
          </g>
        ))}
      </g>
      {geo.map(({ c, cx, cy, lit, dim }) => {
        const { w, h } = c.size
        const accent = cssColor(colorOf?.(c.id)) ?? "var(--muted-foreground)"
        const left = -w / 2 + CALLOUT_ACCENT_PX + CALLOUT_PAD_X
        return (
          <g
            key={c.id}
            data-callout={c.id}
            data-lit={lit ? "" : undefined}
            opacity={dim ? 0.3 : 1}
            className="cursor-pointer"
            {...handlers(c.id)}
          >
            <g transform={`translate(${cx},${cy}) scale(${s})`}>
              <path
                data-part="box"
                d={calloutPath(w, h, c.side)}
                fill="var(--popover)"
                stroke={lit ? "var(--primary)" : "var(--foreground)"}
                strokeOpacity={lit ? 1 : 0.45}
                strokeWidth={lit ? 2 : 1}
                strokeLinejoin="round"
              />
              {/* The tile's colour down the left edge: the box is its. */}
              <rect
                data-part="accent"
                x={-w / 2 + 1.5}
                y={-h / 2 + 2.5}
                width={CALLOUT_ACCENT_PX}
                height={h - 5}
                rx={CALLOUT_ACCENT_PX / 2}
                fill={accent}
              />
              <text
                x={left}
                y={-h / 2 + CALLOUT_PAD_Y + CALLOUT_FONT_PX * 0.65}
                dominantBaseline="central"
                fontSize={CALLOUT_FONT_PX}
                fontWeight={600}
                fill="var(--popover-foreground)"
              >
                {c.name}
              </text>
              {c.lines.map((l, i) => {
                const y =
                  -h / 2 +
                  CALLOUT_PAD_Y +
                  CALLOUT_FONT_PX * 1.3 +
                  i * CALLOUT_LINE_PX +
                  CALLOUT_LINE_PX / 2
                const text = calloutValue(l.value)
                if (l.color === undefined)
                  return (
                    <text
                      key={l.key}
                      data-callout-line={l.key}
                      x={left}
                      y={y}
                      dominantBaseline="central"
                      fontSize={CALLOUT_LINE_FONT_PX}
                      fill="var(--muted-foreground)"
                    >
                      {text}
                    </text>
                  )
                // A status or role: its badge, as everywhere else.
                const bg = cssColor(l.color)
                const tw = text.length * CALLOUT_LINE_FONT_PX * 0.6 + 8
                return (
                  <g key={l.key} data-callout-line={l.key} data-badge="">
                    <rect
                      x={left}
                      y={y - 6.5}
                      width={tw}
                      height={13}
                      rx={3}
                      fill={bg ?? "var(--secondary)"}
                    />
                    <text
                      x={left + 4}
                      y={y}
                      dominantBaseline="central"
                      fontSize={CALLOUT_LINE_FONT_PX}
                      fontWeight={500}
                      fill={
                        bg ? readableText(bg) : "var(--secondary-foreground)"
                      }
                    >
                      {text}
                    </text>
                  </g>
                )
              })}
            </g>
          </g>
        )
      })}
    </g>
  )
}
