import { useEffect, useState } from "react"

import type { FloorPlanTray } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import { CHIP_FONT_PX, LABEL_FONT_PX, textSize } from "./plan-labels"
import type { PlanLabels } from "./plan-label-pass"

const TRAY_DEFAULT = "#71717a"

/** `value`, once it has held still for `ms` - the label pass runs when a
 * pan or a zoom settles, not on every frame. */
export function useSettled<T>(
  value: T,
  ms = 120,
  same?: (a: T, b: T) => boolean
): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (same ? same(settled, value) : Object.is(settled, value)) return
    const id = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(id)
  }, [value, ms, settled, same])
  return settled
}

/**
 * The plan's texts the label pass places (plan-label-pass.ts): cable names
 * along their runs like road names, bundle counts, trays' names along the
 * trays, a traced or hovered cable's ports beside its tiles, and under
 * Readable the grown tiles' names - each at a constant size on screen
 * (`k`, the zoom now), on a halo.
 */
export function PlanLabelsLayer({
  labels,
  k,
  trays,
}: {
  labels: PlanLabels
  k: number
  trays?: readonly FloorPlanTray[]
}) {
  const s = 1 / k
  const trayColor = new Map(
    (trays ?? []).map((t) => [t.id, t.color || TRAY_DEFAULT])
  )
  // Texts: placed and turned, their font and halo in plan px so they read
  // at a constant size on screen; chips scaled whole.
  const at = (p: readonly number[], angle = 0) =>
    `translate(${p[0] * CELL},${p[1] * CELL})${angle ? ` rotate(${angle})` : ""}`
  const chipAt = (p: readonly number[]) => `${at(p)} scale(${s})`
  const halo = {
    className: "fill-foreground stroke-background",
    strokeWidth: 3 * s,
    strokeLinejoin: "round" as const,
    paintOrder: "stroke",
    textAnchor: "middle" as const,
    dominantBaseline: "central" as const,
  }
  // A name on its line: a plate of the page under it, so the line - a
  // traced run's casing, a lane beside it - breaks cleanly round the text
  // instead of showing through a thin halo.
  const knockout = (text: string) => {
    const { w, h } = textSize(text, LABEL_FONT_PX)
    return (
      <rect
        data-part="name-plate"
        x={(-w / 2) * s}
        y={(-h / 2) * s}
        width={w * s}
        height={h * s}
        rx={3 * s}
        fill="var(--background)"
      />
    )
  }
  return (
    <g data-layer="plan-labels" pointerEvents="none">
      {labels.trays.map((l) => (
        <text
          key={l.key}
          data-tray-name={l.id}
          transform={at(l.at, l.angle)}
          fontSize={(LABEL_FONT_PX - 1) * s}
          fontWeight={600}
          {...halo}
          className="stroke-background"
          fill={trayColor.get(l.id) ?? TRAY_DEFAULT}
        >
          {l.text}
        </text>
      ))}
      {labels.bundles.map((l) => (
        <g key={l.key} transform={at(l.at, l.angle)}>
          {knockout(l.text)}
          <text
            data-bundle-name={l.id}
            fontSize={LABEL_FONT_PX * s}
            fontWeight={600}
            {...halo}
          >
            {l.text}
          </text>
        </g>
      ))}
      {labels.cables.map((l) => (
        <g key={l.key} transform={at(l.at, l.angle)}>
          {knockout(l.text + (l.suffix ?? ""))}
          <text
            data-cable-name={l.id}
            fontSize={LABEL_FONT_PX * s}
            fontWeight={500}
            {...halo}
          >
            {l.text}
            {l.suffix && (
              <tspan className="fill-muted-foreground">{l.suffix}</tspan>
            )}
          </text>
        </g>
      ))}
      {labels.tiles.map((l) => (
        <text
          key={l.key}
          data-readable-name={l.id}
          transform={at(l.at)}
          fontSize={LABEL_FONT_PX * s}
          fontWeight={500}
          {...halo}
        >
          {l.text}
        </text>
      ))}
      {labels.ends.map((l) => {
        const { w, h } = textSize(l.text, CHIP_FONT_PX)
        return (
          <g key={l.key} data-end-chip={l.id} transform={chipAt(l.at)}>
            <rect
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              rx={3}
              fill="var(--background)"
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={CHIP_FONT_PX}
              fill="var(--foreground)"
            >
              {l.text}
            </text>
          </g>
        )
      })}
    </g>
  )
}
