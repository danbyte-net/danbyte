import { Handle, Position, type NodeProps } from "@xyflow/react"

import { handleId } from "./stencil-node"

// Aggregated topology node: one card per site (or location) with its device
// count and role breakdown. Double-click drills into the group.

export const GROUP_W = 212
export const GROUP_H = 76

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
  const shown = d.roles.slice(0, 3)
  const extra = d.roles.length - shown.length
  return (
    <div
      className={`flex flex-col justify-center gap-1 overflow-hidden rounded-lg border-2 bg-card px-3 transition-opacity ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      } ${d.dimmed ? "opacity-30" : ""}`}
      style={{ width: GROUP_W, height: GROUP_H }}
      title="Double-click to open this group"
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
        <span className="num shrink-0 text-[11px] text-muted-foreground">
          {d.device_count}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {shown.map((r) => (
          <span
            key={r.name}
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title={r.name}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: r.color || "var(--border)" }}
            />
            <span className="num">{r.count}</span>
          </span>
        ))}
        {extra > 0 && (
          <span className="text-[10px] text-muted-foreground">+{extra}</span>
        )}
        {d.roles.length === 0 && (
          <span className="text-[10px] text-muted-foreground">
            device{d.device_count === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  )
}
