import { useEffect, useRef, useState } from "react"
import { NodeResizer } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"

import { ZONE_COLORS } from "./view-positions"

/**
 * A labelled backdrop box, drawn behind the map so a reader can see at a
 * glance which cards belong together - "WAN circuits", "Comms closet rack".
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
  /** Resizing settles inside React Flow, so the canvas is told to re-read
   * the geometry the same way a drag tells it. */
  onResizeEnd?: () => void
  [key: string]: unknown
}

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
      {/* Resize handles only while selected - eight dots on every zone would
          bury the map they sit behind. */}
      <NodeResizer
        onResizeEnd={() => d.onResizeEnd?.()}
        isVisible={selected}
        color={color}
        minWidth={160}
        minHeight={120}
        lineClassName="!border-2"
        handleClassName="!h-2 !w-2 !rounded-sm"
      />
      <div
        className="h-full w-full rounded-lg border-2"
        style={{
          borderColor: color,
          // A tint, not a fill: the cards on top have to stay readable in
          // both themes, so this never approaches an opaque surface.
          background: `color-mix(in srgb, ${color} 7%, transparent)`,
        }}
      >
        <div
          className="inline-flex max-w-full items-center gap-1 rounded-br-md rounded-tl-[6px] px-2 py-1"
          style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
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
              title="Double-click to rename"
            >
              {d.label || "Zone"}
            </span>
          )}
        </div>
      </div>
    </>
  )
}
