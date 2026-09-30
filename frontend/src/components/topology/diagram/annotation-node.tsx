import { useEffect, useRef, useState } from "react"
import { NodeToolbar, Position } from "@xyflow/react"
import type { Node, NodeProps } from "@xyflow/react"
import { Building2, Cloud, Globe, Pencil, Square, Trash2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { TopologyViewNote } from "@/lib/api"
import { NOTE } from "@/lib/diagram/geometry"
import { cn } from "@/lib/utils"
import { ToolButton } from "./band-node"
import { STACK } from "./card-layout"
import {
  NOTE_ICON_NAMES,
  NOTE_SIZE_NAMES,
  NOTE_TEXT_MAX,
  cleanNoteText,
  moveNotes,
} from "./notes"
import type { NoteIconName, NoteSizeName } from "./notes"

/**
 * A note on the Diagram (notes.ts): free text, or a Lucide icon with its
 * caption centred under it - "NSP1", "MPLS L3VPN", a cloud over
 * "Internet · DC02". Muted ink and no box, unless it is outlined: then it
 * sits on a small chip with a hairline edge, which reads on a line.
 *
 * It stands on its centre, like a card, and paints over the cards and the
 * lines. Nothing attaches to it. Double-click edits the text in place
 * (Enter keeps it, Shift+Enter starts a new line, Esc leaves it as it was);
 * the toolbar above a selected note sets its size, outline or icon, or
 * deletes it. Sizes and gaps come from NOTE (lib/diagram/geometry.ts), so
 * the SVG and draw.io exports put the text where it is here.
 */
export type NotePatch = Partial<Omit<TopologyViewNote, "id" | "kind">>

export interface NoteData {
  note: TopologyViewNote
  /** Open in the editor on mount: a note just added. */
  autoEdit?: boolean
  dimmed?: boolean
  onChange?: (patch: NotePatch) => void
  onDelete?: () => void
  [key: string]: unknown
}

export const NOTE_ICONS: Record<NoteIconName, LucideIcon> = {
  cloud: Cloud,
  globe: Globe,
  building: Building2,
}

export const NOTE_ICON_LABELS: Record<NoteIconName, string> = {
  cloud: "Cloud",
  globe: "Globe",
  building: "Building",
}

const SIZE_LABELS: Record<NoteSizeName, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
}

/** The canvas node id of a note. */
export const noteNodeId = (id: string) => `note:${id}`
const NOTE_PREFIX = "note:"

export interface NoteCallbacks {
  onChange: (id: string, patch: NotePatch) => void
  onDelete: (id: string) => void
}

/** A note as a canvas node: centred on its point, above the cards. */
export function noteToNode(
  n: TopologyViewNote,
  cb: NoteCallbacks,
  opts: { autoEdit?: boolean; selected?: boolean } = {}
): Node {
  const data: NoteData = {
    note: n,
    ...(opts.autoEdit ? { autoEdit: true } : {}),
    onChange: (patch) => cb.onChange(n.id, patch),
    onDelete: () => cb.onDelete(n.id),
  }
  return {
    id: noteNodeId(n.id),
    type: "note",
    position: { x: n.x, y: n.y },
    origin: [0.5, 0.5],
    // With the cards, over every line; later in the list, over them too.
    zIndex: STACK.CARD,
    selectable: true,
    draggable: true,
    ...(opts.selected ? { selected: true } : {}),
    data,
  }
}

/** The notes where the canvas has them now; null when none moved. */
export function notesAt(
  nodes: readonly Node[],
  notes: readonly TopologyViewNote[]
): TopologyViewNote[] | null {
  const at = new Map<string, { x: number; y: number }>()
  for (const n of nodes)
    if (n.type === "note" && n.id.startsWith(NOTE_PREFIX))
      at.set(n.id.slice(NOTE_PREFIX.length), n.position)
  return moveNotes(notes, at)
}

/** The selected notes' ids. */
export function selectedNotes(nodes: readonly Node[]): string[] {
  return nodes
    .filter((n) => n.type === "note" && n.selected)
    .map((n) => n.id.slice(NOTE_PREFIX.length))
}

export function AnnotationNode({ data, selected }: NodeProps) {
  const d = data as NoteData
  const n = d.note
  const sz: NoteSizeName = n.size === "s" || n.size === "l" ? n.size : "m"
  const Icon = n.icon ? NOTE_ICONS[n.icon] : null
  const spec = Icon ? NOTE.ICON[sz] : NOTE.TEXT[sz]
  const iconPx = NOTE.ICON[sz].icon
  const text = n.text ?? ""
  const outline = !Icon && !!n.outline
  const [editing, setEditing] = useState(!!d.autoEdit)
  const [draft, setDraft] = useState(text)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setDraft(text), [text])
  // Into the editor with the text selected, so typing replaces it. A note
  // just added is hidden until React Flow has measured it, and a hidden
  // field takes no focus: try again over the next frames.
  useEffect(() => {
    if (!editing) return
    const take = () => {
      const el = input.current
      if (!el || document.activeElement === el) return
      el.focus()
      el.select()
    }
    take()
    let second = 0
    const first = requestAnimationFrame(() => {
      take()
      second = requestAnimationFrame(take)
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [editing])

  const commit = () => {
    setEditing(false)
    const next = cleanNoteText(draft)
    setDraft(next)
    // A text note with nothing to say is gone; an icon keeps its place.
    if (!Icon && !next) d.onDelete?.()
    else if (next !== text) d.onChange?.({ text: next || undefined })
  }
  const cancel = () => {
    setDraft(text)
    setEditing(false)
  }

  const font = {
    fontSize: spec.size,
    lineHeight: `${spec.lh}px`,
    fontWeight: NOTE.WEIGHT,
  }
  const body = editing ? (
    <textarea
      ref={input}
      value={draft}
      autoFocus
      rows={Math.max(1, draft.split("\n").length)}
      maxLength={NOTE_TEXT_MAX}
      aria-label={Icon ? "Caption" : "Text"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
        if (e.key === "Escape") cancel()
      }}
      className="nodrag nopan nowheel block [field-sizing:content] min-w-16 resize-none overflow-hidden rounded-sm bg-card px-1 text-center whitespace-pre text-foreground ring-2 ring-primary/40 outline-none"
      style={{ ...font, marginTop: Icon ? NOTE.GAP : 0 }}
    />
  ) : text ? (
    <div
      className="whitespace-pre"
      style={{ ...font, marginTop: Icon ? NOTE.GAP : 0 }}
    >
      {text}
    </div>
  ) : null

  return (
    <>
      <NodeToolbar
        isVisible={selected && !editing}
        position={Position.Top}
        offset={8}
      >
        <div className="flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
          <ToolButton
            label="Edit"
            onClick={() => setEditing(true)}
            icon={<Pencil className="size-3" />}
          />
          <span className="mx-0.5 h-4 w-px bg-border" />
          {NOTE_SIZE_NAMES.map((s) => (
            <ToolButton
              key={s}
              label={SIZE_LABELS[s]}
              active={s === sz}
              onClick={() => d.onChange?.({ size: s })}
              icon={
                <span className="text-[11px] leading-none font-semibold">
                  {s.toUpperCase()}
                </span>
              }
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          {Icon ? (
            NOTE_ICON_NAMES.map((name) => {
              const I = NOTE_ICONS[name]
              return (
                <ToolButton
                  key={name}
                  label={NOTE_ICON_LABELS[name]}
                  active={name === n.icon}
                  onClick={() => d.onChange?.({ icon: name })}
                  icon={<I className="size-3" />}
                />
              )
            })
          ) : (
            <ToolButton
              label="Outline"
              active={outline}
              onClick={() =>
                d.onChange?.({ outline: outline ? undefined : true })
              }
              icon={<Square className="size-3" />}
            />
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
          "note-body flex cursor-grab flex-col items-center text-center text-foreground/75 active:cursor-grabbing",
          outline && !editing && "rounded-md border border-border bg-card",
          selected &&
            !editing &&
            "rounded-md outline-1 outline-offset-2 outline-primary/60 outline-dashed",
          d.dimmed && "opacity-30"
        )}
        style={
          outline && !editing
            ? { padding: `${NOTE.PAD_Y - 1}px ${NOTE.PAD_X - 1}px` }
            : undefined
        }
        data-note={Icon ? "icon" : "text"}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
      >
        {Icon && (
          <Icon
            size={iconPx}
            strokeWidth={NOTE.STROKE}
            absoluteStrokeWidth
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        {body}
      </div>
    </>
  )
}
