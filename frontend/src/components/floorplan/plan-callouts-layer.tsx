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

const TAB_H = CALLOUT_TAB_PX
const RADIUS = 4

/** Where the leader leaves the box (px, about its centre). */
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
 * in a plain bordered box, and a thin muted leader from the box's edge to
 * a small dot on the tile, on a casing of the background so it reads over
 * a map, a photo or a dark plan. A callout answers the pointer as its tile does:
 * hovering either lights the pair - a thicker leader in the primary colour,
 * drawn over the rest; the others stay as they are (a name is shown at full
 * ink or not at all). A press opens the tile.
 */
export function PlanCalloutsLayer({
  callouts,
  k,
  hot,
  selected,
  onHover,
  onPress,
}: {
  callouts: readonly CalloutLabel[]
  k: number
  /** The tile hovered (here or on the plan): its callout lit. */
  hot: string | null
  /** The selection: its callouts lit. */
  selected?: ReadonlySet<string>
  /** Unused since boxes dropped their accent; kept for callers. */
  colorOf?: (id: string) => string | undefined
  /** Hovered (null: left), at the pointer. */
  onHover?: (id: string | null, e?: React.PointerEvent) => void
  onPress?: (id: string, e: React.PointerEvent) => void
}) {
  if (!callouts.length) return null
  const s = 1 / k
  const isLit = (id: string) => id === hot || !!selected?.has(id)
  // Lit last, over the rest.
  const order = [...callouts].sort(
    (a, b) => Number(isLit(a.id)) - Number(isLit(b.id))
  )
  const handlers = (id: string) => ({
    onPointerEnter: (e: React.PointerEvent) => onHover?.(id, e),
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
      from: [cx + tx * s, cy + ty * s] as [number, number],
      to: [c.leader[1][0] * CELL, c.leader[1][1] * CELL] as [number, number],
    }
  })
  return (
    <g data-layer="callouts">
      {/* The leaders under the boxes: casing, line, the dot on the tile. */}
      <g data-part="leaders">
        {geo.map(({ c, lit, from, to }) => (
          <g
            key={c.id}
            data-callout-leader={c.id}
            data-lit={lit ? "" : undefined}
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
              strokeWidth={(lit ? 4.5 : 3) * s}
              strokeLinecap="round"
            />
            <line
              data-part="leader"
              x1={from[0]}
              y1={from[1]}
              x2={to[0]}
              y2={to[1]}
              stroke={lit ? "var(--primary)" : "var(--muted-foreground)"}
              strokeWidth={(lit ? 2 : 1.25) * s}
              strokeLinecap="round"
            />
            <circle
              data-part="anchor"
              cx={to[0]}
              cy={to[1]}
              r={(lit ? 2.75 : 2.25) * s}
              fill={lit ? "var(--primary)" : "var(--muted-foreground)"}
            />
          </g>
        ))}
      </g>
      {geo.map(({ c, cx, cy, lit }) => {
        const { w, h } = c.size
        const left = -w / 2 + CALLOUT_ACCENT_PX + CALLOUT_PAD_X
        return (
          <g
            key={c.id}
            data-callout={c.id}
            data-lit={lit ? "" : undefined}
            className="cursor-pointer"
            {...handlers(c.id)}
          >
            <g transform={`translate(${cx},${cy}) scale(${s})`}>
              <rect
                data-part="box"
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                rx={RADIUS}
                fill="var(--popover)"
                stroke={lit ? "var(--primary)" : "var(--border)"}
                strokeWidth={lit ? 1.5 : 1}
              />
              <text
                x={left}
                y={-h / 2 + CALLOUT_PAD_Y + CALLOUT_FONT_PX * 0.65}
                dominantBaseline="central"
                fontSize={CALLOUT_FONT_PX}
                fontWeight={500}
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
