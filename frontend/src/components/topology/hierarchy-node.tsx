import { Handle, Position, type NodeProps } from "@xyflow/react"

import { handleId, type StencilData } from "./stencil-node"
import {
  HIER_HEADER,
  hierHeight,
  hierarchyWidth,
  type HierPortPos,
} from "./layout"

export { hierarchyWidth } from "./layout"

// The Hierarchy view's card: a tall rounded container with the device name
// on a header row and port chips floating at the exact heights the layout
// aligned with their peers - cables run near-straight between them.

export type HierData = StencilData & {
  portPos?: Record<string, HierPortPos>
  portSpan?: number
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  planned: "bg-amber-500",
  staged: "bg-amber-500",
  failed: "bg-red-500",
  offline: "bg-red-500",
  decommissioning: "bg-zinc-400",
}

const HANDLE = "topo-conn"

export function HierarchyNode({ data, selected }: NodeProps) {
  const d = data as HierData
  const width = hierarchyWidth(d)
  const height = hierHeight(d.portSpan ?? 0)
  const ring = selected
    ? "border-primary ring-2 ring-primary/30"
    : d.panel
      ? "border-dashed border-border"
      : "border-border"
  return (
    <div
      className={`relative rounded-xl border bg-card/70 transition-opacity ${ring} ${
        d.dimmed ? "opacity-30" : ""
      }`}
      style={{ width, height }}
    >
      {/* Whole-card fallbacks (LLDP ghost edges). */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      {/* Header: the identity row the reference puts above the ports. */}
      <div
        className="flex items-center gap-1.5 border-b border-border/60 px-2.5"
        style={{ height: HIER_HEADER }}
        // The header truncates on narrow cards - hovering reveals the full
        // identity.
        title={[d.name, d.primary_ip, d.site].filter(Boolean).join(" · ")}
      >
        <span
          className="h-3.5 w-1 shrink-0 rounded-full"
          style={{ background: d.role?.color || "var(--border)" }}
          title={d.role?.name}
        />
        {d.status && (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              STATUS_DOT[d.status] ?? "bg-zinc-400"
            }`}
            title={d.status_display || d.status}
          />
        )}
        <span className="min-w-0 truncate font-mono text-[11px] font-medium">
          {d.name}
        </span>
        <span className="ml-auto min-w-0 truncate text-[9px] text-muted-foreground">
          {[d.primary_ip, d.site].filter(Boolean).join(" · ")}
        </span>
      </div>
      {/* Port chips at their aligned offsets, riding the card's edges. */}
      {Object.entries(d.portPos ?? {}).map(([name, pos]) => {
        const id = handleId(name, pos.side)
        return (
          <div
            key={name}
            className="absolute flex items-center gap-1 rounded border border-border bg-muted/60 px-1 py-px"
            style={{
              // The chip's centre sits exactly at the aligned offset, so the
              // handle (and the cable) land where the layout promised.
              top: pos.off - 8,
              ...(pos.side === "L" ? { left: 5 } : { right: 5 }),
            }}
            title={name}
          >
            <Handle
              type="target"
              id={id}
              position={pos.side === "L" ? Position.Left : Position.Right}
              className={HANDLE}
            />
            <Handle
              type="source"
              id={id}
              position={pos.side === "L" ? Position.Left : Position.Right}
              className={HANDLE}
            />
            <span className="topo-portname max-w-28 truncate font-mono text-[9px] leading-none">
              {name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
