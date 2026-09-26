import { useEffect, useRef, useState } from "react"
import { NodeResizer, NodeToolbar, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { Trash2 } from "lucide-react"

import { ZONE_COLORS } from "./view-positions"

/**
 * A labelled backdrop box, drawn behind the map so a reader can see at a
 * glance which cards belong together - "WAN circuits", "comms closet rack".
 *
 * It is an annotation, not a container: it owns nothing inside it, so
 * dragging one moves the box and leaves every card where it was. That is
 * what makes it safe to draw across a map somebody else arranged.
 *
 * Nothing about it is derived from data - Danbyte will not guess that four
 * cards are "the closet". The user says so.
 */
export interface ZoneData {
  label: string
  color: string
  /** Renaming is inline, so the canvas has to hear about it. */
  onRename?: (label: string) => void
  onRecolor?: (color: string) => void
  onDelete?: () => void
  /** Resizing settles inside React Flow, so the canvas is told to re-read
   * the geometry the same way a drag tells it. */
  onResizeEnd?: () => void
  [key: string]: unknown
}

/** The label bar is the drag handle - see ZONE_DRAG_HANDLE. A whole-box
 * handle sounds friendlier and is not: it eats every pan, marquee-select and
 * click that starts inside the box, which on a zone the size of half the map
 * is most of them. */
export const ZONE_DRAG_HANDLE = "zone-grip"

export function ZoneNode({ data, selected }: NodeProps) {
  const d = data as ZoneData
  const color = ZONE_COLORS.includes(d.color as (typeof ZONE_COLORS)[number])
    ? d.color
    : ZONE_COLORS[0]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(d.label)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(d.label), [d.label])
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== d.label) d.onRename?.(next)
  }

  return (
    <>
      {/* Everything a zone can be told to do, right where it is - a zone has
          no detail panel and nothing else on the canvas leads to it. */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
          {ZONE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => d.onRecolor?.(c)}
              aria-label={`Recolour this zone`}
              className={`size-4 rounded-sm border ${
                c === color ? "border-foreground" : "border-border"
              }`}
              style={{ background: c }}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => d.onDelete?.()}
            aria-label="Delete this zone"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </NodeToolbar>

      {/* Resize handles only while selected - eight dots on every zone would
          bury the map they sit behind. */}
      <NodeResizer
        onResizeEnd={() => d.onResizeEnd?.()}
        isVisible={selected}
        color={color}
        minWidth={160}
        minHeight={120}
        lineClassName="!border-2"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm"
      />
      <div
        // Click-through: the box covers cards and canvas, and swallowing
        // their clicks would make everything under a zone unusable. Only the
        // grip below takes pointer events.
        className="pointer-events-none h-full w-full rounded-lg border-2"
        style={{
          borderColor: color,
          // A tint, not a fill: the cards on top have to stay readable in
          // both themes, so this never approaches an opaque surface.
          background: `color-mix(in srgb, ${color} 7%, transparent)`,
        }}
      >
        <div
          className={`${ZONE_DRAG_HANDLE} pointer-events-auto inline-flex max-w-full cursor-grab items-center gap-1 rounded-tl-[6px] rounded-br-md px-2 py-1 active:cursor-grabbing`}
          style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }}
          data-tip="Drag to move · double-click to rename · right-click for more"
        >
          {editing ? (
            <input
              ref={input}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") commit()
                if (e.key === "Escape") {
                  setDraft(d.label)
                  setEditing(false)
                }
              }}
              className="w-40 bg-transparent text-[12px] font-semibold outline-none"
            />
          ) : (
            <span
              className="truncate text-[12px] font-semibold"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {d.label || "Zone"}
            </span>
          )}
        </div>
      </div>
    </>
  )
}
