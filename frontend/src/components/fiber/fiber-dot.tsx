import { useId } from "react"

import { fiberColor, readableOn } from "@/lib/fiber"
import type { FiberColorEntry } from "@/lib/fiber"

// A single fibre-strand swatch: the strand's colour + a thin contrast outline so
// White/Black/Aqua read on either theme. Fibres are SOLID by default (the
// standard buffer-tube scheme identifies the *unit*, not each fibre); pass
// `showTracer` for the ribbon/tracer style (a diagonal stripe per wrap past 12).

export function FiberDot({
  position,
  palette,
  size = 14,
  title,
  showTracer = false,
}: {
  position: number
  palette?: FiberColorEntry[]
  size?: number
  title?: string
  showTracer?: boolean
}) {
  const c = fiberColor(position, palette)
  const clip = useId()
  const r = size / 2
  const inner = r - 0.75
  const sw = Math.max(1.3, size * 0.15)
  const tracer = readableOn(c.hex)
  const bands = showTracer ? Math.min(c.group, 3) : 0

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-label={`Fibre ${position} — ${c.name}`}
    >
      {title ? <title>{title}</title> : null}
      {bands > 0 && (
        <defs>
          <clipPath id={clip}>
            <circle cx={r} cy={r} r={inner} />
          </clipPath>
        </defs>
      )}
      <circle cx={r} cy={r} r={inner} fill={c.hex} />
      {bands > 0 && (
        <g clipPath={`url(#${clip})`}>
          {Array.from({ length: bands }, (_, i) => {
            const offset = bands > 1 ? (i - (bands - 1) / 2) * sw * 2 : 0
            return (
              <rect
                key={i}
                x={-size}
                y={r - sw / 2 + offset}
                width={size * 3}
                height={sw}
                fill={tracer}
                fillOpacity={0.9}
                transform={`rotate(-45 ${r} ${r})`}
              />
            )
          })}
        </g>
      )}
      <circle
        cx={r}
        cy={r}
        r={inner}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.4}
        strokeWidth={1}
      />
    </svg>
  )
}
