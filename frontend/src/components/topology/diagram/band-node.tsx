import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import {
  EdgeLabelRenderer,
  NodeResizeControl,
  NodeToolbar,
  Position,
  ResizeControlVariant,
} from "@xyflow/react"
import type { ControlLinePosition, NodeProps } from "@xyflow/react"
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react"

import { measureText } from "@/lib/diagram/measure"
import { cn } from "@/lib/utils"
import { ZONE_COLORS } from "../view-positions"
import { BAND, chipWidth, titleSpot } from "./bands"
import type { Rect } from "./types"

/**
 * A layer band on the Diagram (bands.ts): a labelled region behind the
 * cards. A row is a full-width backdrop with its title centred across the
 * top, like the layers of a hand-drawn network diagram ("Spine", "Leaf");
 * it carries the cards whose centre is inside it when it is dragged. A
 * side band is a tall strip beside the rows, its big label reading bottom
 * to top ("WAN", "Data Center fabric").
 *
 * Neutral grey by default; a zone swatch tints it. It paints behind the
 * cables as well as the cards: the canvas stacks it before the cards and
 * blends it (darken on light, lighten on dark), so a cable, and the gap an
 * end label makes in it, reads on the band as it does on the canvas. A
 * row's title is a chip of the band's own colour in the edge-label layer,
 * under the cards: centred in its strip, or - where a cable or a label
 * crosses there - moved along it to the nearest clear spot the plan found
 * (`busy`), so it never hides one.
 *
 * Only the title strip (a row) or the strip itself (a side band) takes the
 * pointer, plus the resize edges while selected - a click anywhere else
 * inside a row still reaches the canvas and the cards on it.
 */
export interface BandData {
  label: string
  /** One of ZONE_COLORS, or null for the neutral grey. */
  color: string | null
  orient: "h" | "v"
  onRename?: (label: string) => void
  onRecolor?: (color: string | null) => void
  onDelete?: () => void
  /** Rows: one place up (-1) or down (+1) the stack, cards and all. */
  onMove?: (dir: -1 | 1) => void
  /** The box after a resize from one of its edges. */
  onResizeEnd?: (rect: Rect) => void
  /** A row: the x spans of its title strip that lines, cards and labels
   * take, as the Diagram last planned them (canvas px). */
  busy?: readonly (readonly [number, number])[]
  [key: string]: unknown
}

/** The swatches' names, for their buttons. */
const SWATCH_NAMES: Record<string, string> = {
  "#64748b": "Slate",
  "#0ea5e9": "Sky",
  "#10b981": "Emerald",
  "#f59e0b": "Amber",
  "#ec4899": "Pink",
  "#8b5cf6": "Violet",
}

/** The grip class - the node's `dragHandle`. */
export const BAND_DRAG_HANDLE = "band-grip"

/** The node-wrapper classes the canvas gives a band: see the note above. */
export const BAND_NODE_CLASS = "mix-blend-darken dark:mix-blend-lighten"

/** A band's surface, opaque in both themes: the neutral grey from the
 * theme's tokens, a swatch as a pastel of it over the card colour. */
export function bandLook(color: string | null): {
  className?: string
  style: CSSProperties
  edge: string
} {
  const c =
    color && (ZONE_COLORS as readonly string[]).includes(color) ? color : null
  return c
    ? {
        style: { background: `color-mix(in srgb, ${c} 12%, var(--card))` },
        edge: `color-mix(in srgb, ${c} 40%, var(--card))`,
      }
    : {
        className:
          "bg-[color-mix(in_oklab,var(--muted)_70%,var(--border))] dark:bg-[color-mix(in_oklab,var(--muted)_75%,var(--card))]",
        style: {},
        edge: "var(--border)",
      }
}

/** A row resizes from its bottom and right edges (its top is its place
 * in the stack); a side band from any edge, to span the rows it names. */
const ROW_EDGES: ControlLinePosition[] = ["bottom", "right"]
const SIDE_EDGES: ControlLinePosition[] = ["top", "bottom", "left", "right"]

export function BandNode({
  data,
  selected,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps) {
  const d = data as BandData
  const side = d.orient === "v"
  const look = bandLook(d.color)
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
  const name = d.label || (side ? "Side band" : "Band")
  const rename = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditing(true)
  }

  const field = (
    <input
      ref={input}
      value={draft}
      autoFocus
      maxLength={80}
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
      className="nodrag pointer-events-auto w-56 rounded-sm bg-card px-1 text-center text-[13px] font-semibold outline-none"
    />
  )

  return (
    <>
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
          <ToolButton
            label="Rename"
            onClick={() => setEditing(true)}
            icon={<Pencil className="size-3" />}
          />
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => d.onRecolor?.(null)}
            aria-label="Neutral"
            data-tip="Neutral"
            className={cn(
              "size-4 rounded-sm border",
              bandLook(null).className,
              d.color === null ? "border-foreground" : "border-border"
            )}
          />
          {/* A swatch's button shows its hue, stronger than the band's
              tint, so slate never reads as the neutral grey. */}
          {ZONE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => d.onRecolor?.(c)}
              aria-label={SWATCH_NAMES[c] ?? c}
              data-tip={SWATCH_NAMES[c] ?? c}
              className={cn(
                "size-4 rounded-sm border",
                c === d.color ? "border-foreground" : "border-border"
              )}
              style={{ background: bandLook(c).edge }}
            />
          ))}
          {!side && (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <ToolButton
                label="Move up"
                onClick={() => d.onMove?.(-1)}
                icon={<ArrowUp className="size-3" />}
              />
              <ToolButton
                label="Move down"
                onClick={() => d.onMove?.(1)}
                icon={<ArrowDown className="size-3" />}
              />
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <ToolButton
            label="Delete"
            onClick={() => d.onDelete?.()}
            icon={<Trash2 className="size-3" />}
            danger
          />
        </div>
      </NodeToolbar>

      <div
        className={cn(
          "band-body relative h-full w-full rounded-lg border",
          look.className,
          selected && "ring-2 ring-primary/40"
        )}
        style={{ ...look.style, borderColor: look.edge }}
        data-band={d.orient}
      >
        {side ? (
          // The whole strip is the grip: nothing is drawn on a side band.
          <div
            className={`${BAND_DRAG_HANDLE} pointer-events-auto flex h-full w-full cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing`}
            data-tip="Move"
          >
            {editing ? (
              field
            ) : (
              <div className="flex max-h-full rotate-180 items-center justify-center [writing-mode:vertical-rl]">
                <span
                  className="truncate text-[20px] leading-none font-semibold whitespace-nowrap text-foreground/75"
                  onDoubleClick={rename}
                >
                  {name}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div
            className={`${BAND_DRAG_HANDLE} pointer-events-auto flex w-full cursor-grab items-center justify-center px-3 active:cursor-grabbing`}
            style={{ height: BAND.TITLE }}
            onDoubleClick={rename}
            data-tip="Move"
          >
            {editing && field}
          </div>
        )}
      </div>

      {/* After the body, so the edges sit over its grip. */}
      {selected &&
        (side ? SIDE_EDGES : ROW_EDGES).map((pos) => (
          <NodeResizeControl
            key={pos}
            position={pos}
            variant={ResizeControlVariant.Line}
            minWidth={BAND.MIN_W}
            minHeight={BAND.MIN_H}
            onResizeEnd={(_, p) =>
              d.onResizeEnd?.({ x: p.x, y: p.y, w: p.width, h: p.height })
            }
            className={cn(
              "pointer-events-auto !border-0 hover:!bg-primary/40",
              pos === "left" || pos === "right" ? "!w-2" : "!h-2"
            )}
          />
        ))}

      {!side && !editing && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "band-title pointer-events-none absolute truncate rounded-md px-2 text-[13px] leading-6 font-semibold whitespace-nowrap text-foreground/75",
              look.className
            )}
            style={{
              ...look.style,
              maxWidth: Math.max(0, (width ?? 0) - 16),
              transform: `translate(-50%, -50%) translate(${titleX(
                name,
                positionAbsoluteX,
                width ?? 0,
                d.busy
              )}px, ${positionAbsoluteY + Math.min(BAND.TITLE, height ?? BAND.TITLE) / 2}px)`,
            }}
          >
            {name}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** Where a row's title chip is centred (canvas x): `titleSpot` for the
 * chip the name makes, clear of the spans the plan found. */
function titleX(
  name: string,
  x: number,
  w: number,
  busy: readonly (readonly [number, number])[] | undefined
): number {
  const chip = chipWidth(measureText(name, BAND.CHIP_SIZE, 600), w)
  return titleSpot({ x, y: 0, w, h: BAND.TITLE }, chip, busy)
}

/** A small button in a region's or note's toolbar. `active` marks the
 * current choice of a set (a note's size). */
export function ToolButton({
  label,
  icon,
  onClick,
  danger,
  active,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  danger?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      className={cn(
        "flex size-5 items-center justify-center rounded-sm text-muted-foreground",
        active && "bg-muted text-foreground",
        danger ? "hover:text-destructive" : "hover:text-foreground"
      )}
    >
      {icon}
    </button>
  )
}
