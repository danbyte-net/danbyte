import { Handle, Position, type NodeProps } from "@xyflow/react"

import type { TopoNode } from "@/lib/api"
import type { StencilData } from "./stencil-node"

// The Faceplates view: the device IS its front photo. Cables plug into the
// image-port markers' true positions on the picture (fractions of the image,
// placed on the device type's photo in the image-ports editor); cabled ports
// without a marker fall back to stubs along the bottom edge.

export const PHOTO_W = 520
export const PHOTO_HEADER = 22
const U_PX = 40 // 19-inch aspect at PHOTO_W: ~40px per rack unit

export function photoSize(d: TopoNode["data"]): {
  width: number
  height: number
} {
  return {
    width: PHOTO_W,
    height: PHOTO_HEADER + Math.max(1, d.u_height ?? 1) * U_PX,
  }
}

const HANDLE =
  "!h-2 !w-2 !rounded-full !border !border-background !bg-primary/80"

export function PhotoNode({ data, selected }: NodeProps) {
  const d = data as StencilData
  const { width, height } = photoSize(d)
  const imgH = height - PHOTO_HEADER
  const markers = d.image_ports ?? []
  const marked = new Set(markers.map((m) => m.name))
  const cabled: string[] = []
  for (const p of d.ports ?? []) {
    cabled.push(p.name)
    if (p.pair) cabled.push(p.pair)
  }
  const unmarked = cabled.filter((n) => !marked.has(n))
  return (
    <div
      className={`overflow-hidden rounded-md border bg-card transition-opacity ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      } ${d.dimmed ? "opacity-30" : ""}`}
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
      <div
        className="flex items-center gap-1.5 border-b border-border bg-card px-2"
        style={{ height: PHOTO_HEADER }}
      >
        <span className="min-w-0 truncate font-mono text-[11px] font-medium">
          {d.name}
        </span>
        <span className="ml-auto shrink-0 truncate text-[9px] text-muted-foreground">
          {d.site ?? ""}
        </span>
      </div>
      <div className="relative" style={{ height: imgH }}>
        {d.front_image && (
          // Stretch to the reserved box: markers are fractions of the image,
          // so stretching keeps them true to the photo.
          <img
            src={d.front_image}
            alt={d.name}
            draggable={false}
            className="h-full w-full select-none"
            style={{ objectFit: "fill" }}
          />
        )}
        {/* Marker ports: the cable plugs into the real spot on the photo. */}
        {markers.map((m) => (
          <div
            key={m.name}
            className="absolute"
            style={{
              left: `${(m.x + m.w / 2) * 100}%`,
              top: `${(m.y + m.h / 2) * 100}%`,
            }}
            title={m.name}
          >
            <Handle type="target" id={m.name} position={Position.Bottom} className={HANDLE} />
            <Handle type="source" id={m.name} position={Position.Bottom} className={HANDLE} />
          </div>
        ))}
        {/* Cabled ports with no marker: stubs along the bottom edge. */}
        {unmarked.map((name, i) => (
          <div
            key={name}
            className="absolute bottom-0"
            style={{ left: `${((i + 1) / (unmarked.length + 1)) * 100}%` }}
            title={name}
          >
            <Handle type="target" id={name} position={Position.Bottom} className={HANDLE} />
            <Handle type="source" id={name} position={Position.Bottom} className={HANDLE} />
          </div>
        ))}
      </div>
    </div>
  )
}
