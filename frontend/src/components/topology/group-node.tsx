import { Handle, Position, type NodeProps } from "@xyflow/react"

import { ColorBadge } from "@/components/cells/color-badge"

import { GROUP_H, GROUP_W } from "./group-size"
import { handleId } from "./stencil-node"

// Aggregated topology node: one card per site (or location) with its device
// count and its biggest roles as their badges. Double-click drills into the
// group.

export { GROUP_H, GROUP_W }

export interface TopoGroupData {
  group_id: string | null
  kind: "site" | "location"
  name: string
  device_count: number
  roles: { name: string; color: string; count: number }[]
  dimmed?: boolean
}

/** Data of an aggregated group-to-group edge. */
export interface GroupEdgeInfo {
  cable_count: number
  types: string[]
}

const SIDES = [
  { side: "L", pos: Position.Left },
  { side: "R", pos: Position.Right },
  { side: "T", pos: Position.Top },
  { side: "B", pos: Position.Bottom },
] as const

export function GroupNode({ data, selected }: NodeProps) {
  const d = data as unknown as TopoGroupData
  // Two badges fit the card whole; more would all end in an ellipsis.
  const shown = d.roles.slice(0, 2)
  const extra = d.roles.length - shown.length
  return (
    <div
      className={`flex flex-col justify-center gap-1 overflow-hidden rounded-lg border-2 bg-card px-3 transition-opacity ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      } ${d.dimmed ? "opacity-30" : ""}`}
      style={{ width: GROUP_W, height: GROUP_H }}
    >
      {SIDES.map(({ side, pos }) => (
        <span key={side}>
          <Handle
            type="target"
            id={handleId("n", side)}
            position={pos}
            className="!h-1 !w-1 !border-0 !bg-transparent"
          />
          <Handle
            type="source"
            id={handleId("n", side)}
            position={pos}
            className="!h-1 !w-1 !border-0 !bg-transparent"
          />
        </span>
      ))}
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {d.name}
        </span>
        <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
          <span className="num">{d.device_count}</span>{" "}
          {d.device_count === 1 ? "device" : "devices"}
        </span>
      </div>
      {shown.length > 0 && (
        // The biggest roles as their badges, sharing the row; a long name
        // ends in an ellipsis and its tip has it in full.
        <div className="flex min-w-0 items-center gap-1">
          {shown.map((r) => (
            <span
              key={r.name}
              className="flex min-w-0 shrink"
              data-tip={`${r.name} · ${r.count}`}
              data-tip-plain=""
            >
              <ColorBadge
                name={r.name}
                color={r.color || undefined}
                // A block badge has no flex gap: the count keeps its own.
                suffix={<span className="num ml-1">{r.count}</span>}
                className="block h-4 max-w-full min-w-0 truncate px-1.5 py-0 text-[10px] leading-[14px]"
              />
            </span>
          ))}
          {extra > 0 && (
            <span className="num shrink-0 text-[10px] text-muted-foreground">
              +{extra}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
