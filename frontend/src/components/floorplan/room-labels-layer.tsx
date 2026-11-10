import { CELL } from "./canvas-geometry"
import { ROOM_FACT_PX, ROOM_NAME_PX } from "./plan-detail"
import type { RoomLabel } from "./plan-detail"
import { CHECK_COLOR } from "./tile-paint"

// Detail by zoom, from afar: each room's one label - its name centred on
// it, a muted line of facts under it, its alarm's badge by the name. A
// constant size on screen (world px over the zoom), on a halo of the page
// so it reads over the room's tint and its walls. Takes no pointer: the
// room under it does.

const BADGE_PX = 10

export function RoomLabelsLayer({
  labels,
  k,
}: {
  labels: readonly RoomLabel[]
  k: number
}) {
  if (!labels.length) return null
  const u = 1 / k
  return (
    <g data-layer="room-labels" pointerEvents="none">
      {labels.map((l) => {
        const x = l.at[0] * CELL
        const y = l.at[1] * CELL
        const nameY = l.facts ? y - ROOM_FACT_PX * 0.62 * u : y
        const badgeW = l.badge ? (l.badge.length * BADGE_PX * 0.6 + 10) * u : 0
        const nameW = l.name.length * ROOM_NAME_PX * 0.6 * u
        const gap = 5 * u
        // The name and the badge after it, centred together.
        const nameX = x - (badgeW ? badgeW + gap : 0) / 2
        const halo = {
          className: "stroke-background",
          strokeWidth: 3.5 * u,
          strokeOpacity: 0.9,
          strokeLinejoin: "round" as const,
          paintOrder: "stroke" as const,
        }
        return (
          <g
            key={l.id}
            data-room-label={l.id}
            transform={l.angle ? `rotate(${l.angle},${x},${y})` : undefined}
          >
            <text
              data-part="room-name"
              x={nameX}
              y={nameY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={ROOM_NAME_PX * u}
              fontWeight={l.minor ? 500 : 600}
              fill={l.minor ? "var(--muted-foreground)" : "var(--foreground)"}
              {...halo}
            >
              {l.name}
            </text>
            {l.badge && (
              <g data-part="room-alarm">
                <rect
                  x={nameX + nameW / 2 + gap}
                  y={nameY - 8 * u}
                  width={badgeW}
                  height={16 * u}
                  rx={3 * u}
                  fill={CHECK_COLOR[l.check ?? ""] ?? "var(--destructive)"}
                />
                <text
                  x={nameX + nameW / 2 + gap + badgeW / 2}
                  y={nameY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={BADGE_PX * u}
                  fontWeight={600}
                  fill="#ffffff"
                >
                  {l.badge}
                </text>
              </g>
            )}
            {l.facts && (
              <text
                data-part="room-facts"
                x={x}
                y={y + ROOM_NAME_PX * 0.62 * u}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={ROOM_FACT_PX * u}
                fill="var(--muted-foreground)"
                className="num stroke-background"
                strokeWidth={3 * u}
                strokeOpacity={0.9}
                strokeLinejoin="round"
                paintOrder="stroke"
              >
                {l.facts}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}
