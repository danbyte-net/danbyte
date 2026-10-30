import type { FloorPlanTray } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import type { Pt } from "./cable-route"

/** Default tray color when the user hasn't picked one - neutral gray. */
const TRAY_DEFAULT = "#71717a"

/** A tray run: a subtle hollow channel (no bright core - cables show *inside*
 * it when traced). Selected shows vertex dots; editing shows drag handles plus
 * per-segment "+" bend-inserters. */
export function TrayShape({
  tray,
  selected,
  interactive,
  editable,
  editing,
  dimmed,
  onPointerDown,
  onDoubleClick,
  onVertexDown,
  onInsertBend,
  onVertexContext,
}: {
  tray: FloorPlanTray
  selected: boolean
  interactive: boolean
  editable: boolean
  editing: boolean
  dimmed: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
  onVertexDown: (index: number, e: React.PointerEvent) => void
  onInsertBend: (segIndex: number, e: React.PointerEvent) => void
  onVertexContext: (index: number, e: React.MouseEvent) => void
}) {
  if (tray.points.length < 2) return null
  const color = tray.color || TRAY_DEFAULT
  const pts = tray.points.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const mid = tray.points[Math.floor(tray.points.length / 2)]
  const count = tray.cables.length
  // Show handles when editing this tray, or (for a quick reshape) when it's
  // the plain selection.
  const showHandles = editable && (editing || selected)

  return (
    <g
      opacity={dimmed ? 0.3 : 1}
      onPointerDown={interactive ? onPointerDown : undefined}
      onDoubleClick={interactive ? onDoubleClick : undefined}
      style={{
        cursor: interactive ? (editable ? "move" : "pointer") : "default",
      }}
    >
      <title>
        {tray.name}
        {tray.kind ? ` · ${tray.kind}` : ""} · {count} cable
        {count === 1 ? "" : "s"}
        {interactive && !editing ? " · double-click to edit shape" : ""}
      </title>
      {/* Channel body - wide + faint. No centerline: the middle stays empty
          so a traced cable reads as running inside the tray. */}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeOpacity={editing ? 0.6 : selected ? 0.5 : 0.3}
        strokeWidth={editing || selected ? 11 : 10}
        strokeLinejoin="round"
        strokeLinecap="round"
        pointerEvents={interactive ? "stroke" : "none"}
      />
      {/* Per-segment "+" handles to insert a bend (edit mode). */}
      {editing &&
        tray.points.slice(0, -1).map(([x, y], i) => {
          const [nx, ny] = tray.points[i + 1]
          const cx = ((x + nx) / 2) * CELL
          const cy = ((y + ny) / 2) * CELL
          return (
            <g
              key={`add-${i}`}
              style={{ cursor: "copy" }}
              onPointerDown={(e) => onInsertBend(i, e)}
            >
              <title>Insert a bend</title>
              <circle
                cx={cx}
                cy={cy}
                r={5}
                fill="var(--background)"
                stroke={color}
                strokeWidth={1.25}
                strokeDasharray="2 1.5"
              />
              <path
                d={`M ${cx - 2.5} ${cy} H ${cx + 2.5} M ${cx} ${cy - 2.5} V ${cy + 2.5}`}
                stroke={color}
                strokeWidth={1.25}
                strokeLinecap="round"
                pointerEvents="none"
              />
            </g>
          )
        })}
      {showHandles &&
        tray.points.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * CELL}
            cy={y * CELL}
            r={editing ? 5 : 4.5}
            fill={editing ? color : "var(--background)"}
            fillOpacity={editing ? 0.9 : 1}
            stroke={color}
            strokeWidth={1.75}
            style={{ cursor: "grab" }}
            pointerEvents="auto"
            onPointerDown={(e) => onVertexDown(i, e)}
            onContextMenu={editing ? (e) => onVertexContext(i, e) : undefined}
          />
        ))}
      <text
        x={mid[0] * CELL}
        y={mid[1] * CELL - 9}
        textAnchor="middle"
        fontSize={10}
        fill={color}
        fontWeight={600}
        pointerEvents="none"
      >
        {tray.name}
        {count > 0 ? ` · ${count}` : ""}
      </text>
    </g>
  )
}

/** One cable's physical run, already routed through its trays (cell units).
 * Rendered as a polyline through the tray channels with a dot at each end. */
export function CableLink({
  route,
  color: rawColor,
  label,
  type,
  highlighted,
  dimmed,
  interactive,
  onSelect,
}: {
  route: Pt[]
  color: string
  label: string
  type: string
  highlighted: boolean
  dimmed: boolean
  interactive: boolean
  onSelect: () => void
}) {
  if (route.length < 2) return null
  const color = rawColor || "#0ea5e9"
  const pts = route.map(([x, y]) => `${x * CELL},${y * CELL}`).join(" ")
  const a = route[0]
  const b = route[route.length - 1]
  const opacity = dimmed ? 0.2 : 1
  return (
    <g
      opacity={opacity}
      onPointerDown={
        interactive
          ? (e) => {
              e.stopPropagation()
              onSelect()
            }
          : undefined
      }
      style={{ cursor: interactive ? "pointer" : "default" }}
    >
      <title>
        {label}
        {type ? ` · ${type}` : ""} (A↔B)
      </title>
      {interactive && (
        <polyline
          points={pts}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
        />
      )}
      {/* Highlighted run gets a soft halo so it reads clearly on top of the
          cables it shares a path with. */}
      {highlighted && (
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeOpacity={0.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={highlighted ? 3.5 : 1.5}
        strokeOpacity={highlighted ? 1 : 0.6}
        strokeDasharray={highlighted ? "7 5" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      >
        {highlighted && (
          <animate
            attributeName="stroke-dashoffset"
            from="24"
            to="0"
            dur="0.7s"
            repeatCount="indefinite"
          />
        )}
      </polyline>
      {[a, b].map((p, i) => (
        <circle
          key={i}
          cx={p[0] * CELL}
          cy={p[1] * CELL}
          r={highlighted ? 5.5 : 3.5}
          fill={color}
          stroke="var(--background)"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      ))}
    </g>
  )
}
