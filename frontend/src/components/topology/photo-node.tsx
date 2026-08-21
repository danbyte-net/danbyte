import { Handle, Position, type NodeProps } from "@xyflow/react"

import type { TopoNode } from "@/lib/api"
import type { StencilData } from "./stencil-node"

// The Faceplates view: the device IS its front photo, rendered exactly like
// the device page's photo faceplate - natural aspect, image-port markers as
// center-anchored overlay rectangles (x/y are the marker's CENTER, w/h its
// size, all fractions of the image). The cable anchors at the marker's
// center; cabled ports without a marker fall back to bottom stubs.

export const PHOTO_W = 520
export const PHOTO_HEADER = 22
const U_PX = 40 // fallback aspect when the image's own is unknown

export function photoSize(d: TopoNode["data"]): {
  width: number
  height: number
} {
  const imgH = d.front_image_aspect
    ? PHOTO_W * d.front_image_aspect
    : Math.max(1, d.u_height ?? 1) * U_PX
  return { width: PHOTO_W, height: PHOTO_HEADER + imgH }
}

// The edge anchors exactly at the marker's centre.
const CENTER_HANDLE =
  "!absolute !left-1/2 !top-1/2 !h-1 !w-1 !-translate-x-1/2 !-translate-y-1/2 !border-0 !bg-transparent"

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
      className={`overflow-hidden rounded-md border bg-muted/30 transition-opacity ${
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
          // The box's aspect IS the image's aspect - no distortion, and the
          // fractional markers land exactly where they were placed.
          <img
            src={d.front_image}
            alt={d.name}
            draggable={false}
            className="h-full w-full select-none"
            style={{ objectFit: "fill" }}
          />
        )}
        {/* Center-anchored marker rectangles, /devices photo-port style:
            an emphasized border over the artwork, cable from the middle. */}
        {markers.map((m) => (
          <div
            key={m.name}
            className="absolute rounded-[2px] border border-sky-400/60 hover:border-sky-400"
            style={{
              left: `${(m.x - m.w / 2) * 100}%`,
              top: `${(m.y - m.h / 2) * 100}%`,
              width: `${m.w * 100}%`,
              height: `${m.h * 100}%`,
            }}
            title={m.name}
          >
            <Handle
              type="target"
              id={m.name}
              position={m.y < 0.5 ? Position.Top : Position.Bottom}
              className={CENTER_HANDLE}
            />
            <Handle
              type="source"
              id={m.name}
              position={m.y < 0.5 ? Position.Top : Position.Bottom}
              className={CENTER_HANDLE}
            />
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
            <Handle
              type="target"
              id={name}
              position={Position.Bottom}
              className="!h-2 !w-2 !rounded-full !border !border-background !bg-primary/80"
            />
            <Handle
              type="source"
              id={name}
              position={Position.Bottom}
              className="!h-2 !w-2 !rounded-full !border !border-background !bg-primary/80"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
