import { Handle, Position, type NodeProps } from "@xyflow/react"

import { handleId, type StencilData } from "./stencil-node"

// The Flat view's barebones device chip: fixed size, no port rows, whole-node
// connections. Same data shape as the stencil card, so the canvas can flip
// between the two without touching the graph payload.

export const FLAT_W = 156
export const FLAT_H = 46

/** Chip width sized to the device name (11px mono), capped. */
export function flatW(d: { name?: string }): number {
  return Math.max(FLAT_W, Math.min(250, 40 + (d.name?.length ?? 0) * 6.6))
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  planned: "bg-amber-500",
  staged: "bg-amber-500",
  failed: "bg-red-500",
  offline: "bg-red-500",
  decommissioning: "bg-zinc-400",
}

// Four invisible handles named after the single pseudo-port "n" - the canvas
// re-points each edge at the side facing its neighbour (same side machinery
// the stencil ports use, collapsed to one port per card).
const SIDES = [
  { side: "L", pos: Position.Left },
  { side: "R", pos: Position.Right },
  { side: "T", pos: Position.Top },
  { side: "B", pos: Position.Bottom },
] as const

export function FlatNode({ data, selected }: NodeProps) {
  const d = data as StencilData
  return (
    <div
      className={`flex items-center gap-2 overflow-hidden rounded-md border bg-card px-2 transition-opacity ${
        selected
          ? "border-primary ring-2 ring-primary/30"
          : d.panel
            ? "border-dashed border-border"
            : "border-border"
      } ${d.dimmed ? "opacity-30" : ""}`}
      style={{ width: flatW(d), height: FLAT_H }}
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
      <span
        className="h-7 w-1 shrink-0 rounded-full"
        style={{ background: d.role?.color || "var(--border)" }}
        title={d.role?.name}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {d.status && (
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                STATUS_DOT[d.status] ?? "bg-zinc-400"
              }`}
              title={d.status_display || d.status}
            />
          )}
          <span className="truncate font-mono text-[11px] font-medium">
            {d.name}
          </span>
        </div>
        <div className="truncate text-[9px] text-muted-foreground">
          {d.panel ? "patch panel" : d.site || d.device_type || "-"}
        </div>
      </div>
    </div>
  )
}
