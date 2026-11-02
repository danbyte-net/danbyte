import { readableText } from "@/lib/color"
import { cssColor } from "@/lib/utils"

import { CELL } from "./canvas-geometry"
import {
  CALLOUT_FONT_PX,
  CALLOUT_LINE_FONT_PX,
  CALLOUT_LINE_PX,
  CALLOUT_PAD_X,
  CALLOUT_PAD_Y,
  calloutValue,
} from "./plan-callouts"
import type { CalloutLabel } from "./plan-label-pass"

/**
 * The callouts the label pass placed (plan-callouts.ts): each a small box
 * at a constant size on screen (`k`, the zoom now) with the tile's name
 * and the lines its panel layout chose - a status or role as its badge -
 * and a thin leader to the tile's edge. A callout answers the pointer as
 * its tile does: hovering either lights both, a press opens the tile.
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
  onHover?: (id: string | null) => void
  onPress?: (id: string, e: React.PointerEvent) => void
}) {
  if (!callouts.length) return null
  const s = 1 / k
  // Lit last, over the rest.
  const order = [...callouts].sort(
    (a, b) =>
      Number(a.id === hot || !!selected?.has(a.id)) -
      Number(b.id === hot || !!selected?.has(b.id))
  )
  return (
    <g data-layer="callouts">
      {order.map((c) => {
        const lit = c.id === hot || !!selected?.has(c.id)
        const cx = c.at[0] * CELL
        const cy = c.at[1] * CELL
        const hw = (c.size.w / 2) * s
        const hh = (c.size.h / 2) * s
        // The leader's box end, on the box as drawn at this zoom.
        const tile: [number, number] = [
          c.leader[1][0] * CELL,
          c.leader[1][1] * CELL,
        ]
        const r = 4 * s
        const clampX = Math.min(cx + hw - r, Math.max(cx - hw + r, tile[0]))
        const clampY = Math.min(cy + hh - r, Math.max(cy - hh + r, tile[1]))
        const from: [number, number] =
          c.side === "top"
            ? [clampX, cy + hh]
            : c.side === "bottom"
              ? [clampX, cy - hh]
              : c.side === "left"
                ? [cx + hw, clampY]
                : [cx - hw, clampY]
        const { w, h } = c.size
        return (
          <g
            key={c.id}
            data-callout={c.id}
            data-lit={lit ? "" : undefined}
            className="cursor-pointer"
            onPointerEnter={() => onHover?.(c.id)}
            onPointerLeave={() => onHover?.(null)}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              onPress?.(c.id, e)
            }}
          >
            <line
              data-part="leader"
              x1={from[0]}
              y1={from[1]}
              x2={tile[0]}
              y2={tile[1]}
              stroke={lit ? "var(--primary)" : "var(--muted-foreground)"}
              strokeWidth={(lit ? 1.5 : 1) * s}
              strokeOpacity={lit ? 1 : 0.7}
            />
            <g transform={`translate(${cx},${cy}) scale(${s})`}>
              <rect
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                rx={6}
                fill="var(--popover)"
                stroke={lit ? "var(--primary)" : "var(--border)"}
                strokeWidth={lit ? 1.5 : 1}
              />
              <text
                x={-w / 2 + CALLOUT_PAD_X}
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
                const x = -w / 2 + CALLOUT_PAD_X
                const text = calloutValue(l.value)
                if (l.color === undefined)
                  return (
                    <text
                      key={l.key}
                      data-callout-line={l.key}
                      x={x}
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
                      x={x}
                      y={y - 6.5}
                      width={tw}
                      height={13}
                      rx={3}
                      fill={bg ?? "var(--secondary)"}
                    />
                    <text
                      x={x + 4}
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
