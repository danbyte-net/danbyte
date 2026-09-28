import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import {
  EdgeLabelRenderer,
  NodeResizeControl,
  NodeToolbar,
  Position,
  ResizeControlVariant,
  useStore,
} from "@xyflow/react"
import type {
  ControlLinePosition,
  NodeProps,
  ReactFlowState,
} from "@xyflow/react"
import {
  ArrowDown,
  ArrowUp,
  FoldVertical,
  Layers,
  Pencil,
  RectangleHorizontal,
  Rows3,
  Trash2,
  UnfoldVertical,
} from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { measureText } from "@/lib/diagram/measure"
import { cn } from "@/lib/utils"
import { ZONE_COLORS } from "../view-positions"
import {
  BAND,
  chipWidth,
  isStacked,
  subDividers,
  subRowsOf,
  titleSpot,
} from "./bands"
import type { ArrangeCard, BandBy, BandLayout, Region, SubRow } from "./bands"
import { SWATCH_NAMES } from "./swatch-names"
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
 * A row can hold several layers (roles or device types, Layers). Stacked,
 * each layer's cards stand on a sub-row of their own under the one title,
 * its badge at the left and a faint rule between sub-rows - read off the
 * cards where they stand, like the band's membership.
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
  /** A row's layers: the roles or device types it holds. */
  rule?: { by: BandBy; ids: string[] }
  /** A row of several layers: a sub-row each, or one row. */
  layout?: BandLayout
  /** A row with another under it in its stack. */
  canMerge?: boolean
  onRename?: (label: string) => void
  onRecolor?: (color: string | null) => void
  onDelete?: () => void
  /** Rows: one place up (-1) or down (+1) the stack, cards and all. */
  onMove?: (dir: -1 | 1) => void
  /** The box after a resize from one of its edges. */
  onResizeEnd?: (rect: Rect) => void
  /** A row: the layers it holds now, by roles or by device types. */
  onLayers?: (by: BandBy, ids: string[]) => void
  onLayout?: (layout: BandLayout) => void
  /** A row: one band with the row under it. */
  onMerge?: () => void
  /** A row of several layers: a band per layer. */
  onSplit?: () => void
  /** A row: the x spans of its title strip that lines, cards and labels
   * take, as the Diagram last planned them (canvas px). */
  busy?: readonly (readonly [number, number])[]
  /** Set by the band's menu (Rename): a new stamp opens the title's
   * editor. */
  renameAt?: number
  [key: string]: unknown
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
  id,
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
  const layers = d.rule?.ids.length ?? 0
  const subs = useSubRows(
    id,
    {
      x: positionAbsoluteX,
      y: positionAbsoluteY,
      w: width ?? 0,
      h: height ?? 0,
    },
    side ? undefined : d.rule,
    d.layout
  )
  const [draft, setDraft] = useState(d.label)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(d.label), [d.label])
  useEffect(() => {
    if (d.renameAt) setEditing(true)
  }, [d.renameAt])
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
            data-tip-plain=""
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
              data-tip-plain=""
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
              <LayersPicker
                rule={d.rule}
                band={id}
                onPick={(by, ids) => d.onLayers?.(by, ids)}
              />
              {layers > 1 && (
                <>
                  <ToolButton
                    label="Sub-rows"
                    active={d.layout === "stack"}
                    onClick={() => d.onLayout?.("stack")}
                    icon={<Rows3 className="size-3" />}
                  />
                  <ToolButton
                    label="One row"
                    active={d.layout !== "stack"}
                    onClick={() => d.onLayout?.("row")}
                    icon={<RectangleHorizontal className="size-3" />}
                  />
                </>
              )}
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
              {(d.canMerge || layers > 1) && (
                <span className="mx-0.5 h-4 w-px bg-border" />
              )}
              {d.canMerge && (
                <ToolButton
                  label="Merge with band below"
                  onClick={() => d.onMerge?.()}
                  icon={<FoldVertical className="size-3" />}
                />
              )}
              {layers > 1 && (
                <ToolButton
                  label="Split into layers"
                  onClick={() => d.onSplit?.()}
                  icon={<UnfoldVertical className="size-3" />}
                />
              )}
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
            data-tip-plain=""
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
            data-tip-plain=""
          >
            {editing && field}
          </div>
        )}
        {/* A faint rule between the sub-rows of a stacked row. */}
        {subDividers(subs).map((y) => (
          <div
            key={y}
            className="band-divider pointer-events-none absolute border-t border-dashed"
            style={{
              top: y - positionAbsoluteY,
              left: BAND.SUB_EDGE,
              right: BAND.SUB_EDGE,
              borderColor: look.edge,
            }}
          />
        ))}
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
          {/* Each sub-row's layer, at its left: the role's own badge. */}
          {subs
            .filter((s) => s.label)
            .map((s) => (
              <div
                key={s.layer ?? ""}
                className="band-sublabel pointer-events-none absolute"
                style={{
                  transform: `translate(0, -50%) translate(${
                    positionAbsoluteX + BAND.SUB_EDGE
                  }px, ${s.y + s.h / 2}px)`,
                }}
              >
                <ColorBadge name={s.label} color={s.color ?? undefined} />
              </div>
            ))}
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/** A card node's type: every node but the regions, notes and junctions. */
const NOT_CARDS = new Set(["zone", "band", "note", "junction"])

interface CardInfo {
  device_id?: string
  role?: { id?: string; name: string; color?: string | null } | null
  device_type_id?: string | null
  device_type?: string | null
}

/** A card node as a band sorts it, when it has been measured. */
function cardOf(
  n: ReactFlowState["nodeLookup"] extends Map<string, infer N> ? N : never
): ArrangeCard | null {
  if (n.hidden || NOT_CARDS.has(n.type ?? "")) return null
  const d = n.data as CardInfo
  if (!d.device_id) return null
  const w = n.width ?? n.measured.width
  const h = n.height ?? n.measured.height
  if (!w || !h) return null
  const [ox, oy] = n.origin ?? [0, 0]
  return {
    id: n.id,
    box: { x: n.position.x - ox * w, y: n.position.y - oy * h, w, h },
    role: d.role
      ? { id: d.role.id, name: d.role.name, color: d.role.color }
      : null,
    type: d.device_type_id
      ? { id: d.device_type_id, name: d.device_type }
      : null,
  }
}

/** A stacked row's sub-rows, read off its cards where they stand now. */
function useSubRows(
  id: string,
  box: Rect,
  rule: BandData["rule"],
  layout: BandLayout | undefined
): SubRow[] {
  const { x, y, w, h } = box
  const region = useMemo<Region>(
    () => ({
      id,
      kind: "band",
      orient: "h",
      label: "",
      color: null,
      x,
      y,
      w,
      h,
      ...(rule ? { rule } : {}),
      ...(layout ? { layout } : {}),
    }),
    [id, x, y, w, h, rule, layout]
  )
  const stacked = isStacked(region)
  const select = useCallback(
    (s: ReactFlowState) => {
      if (!stacked) return ""
      const cards: ArrangeCard[] = []
      for (const n of s.nodeLookup.values()) {
        const c = cardOf(n)
        if (!c) continue
        const cx = c.box.x + c.box.w / 2
        const cy = c.box.y + c.box.h / 2
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) cards.push(c)
      }
      return JSON.stringify(subRowsOf(region, cards))
    },
    [stacked, region, x, y, w, h]
  )
  const sig = useStore(select)
  return useMemo(() => (sig ? (JSON.parse(sig) as SubRow[]) : []), [sig])
}

/** A layer the picker offers: a role or device type on the map. */
interface LayerOption {
  id: string
  name: string
  color: string | null
  /** The other row that holds it now, by name. */
  held?: string
}

/** The roles and device types on the map, and the rows that hold them. */
function optionsOf(s: ReactFlowState, band: string) {
  const roles = new Map<string, LayerOption>()
  const types = new Map<string, LayerOption>()
  const held: Record<BandBy, Map<string, string>> = {
    role: new Map(),
    device_type: new Map(),
  }
  for (const n of s.nodeLookup.values()) {
    if (n.type === "band" && n.id !== band) {
      const b = n.data as BandData
      if (b.orient === "v" || !b.rule) continue
      for (const id of b.rule.ids) held[b.rule.by].set(id, b.label || "Band")
      continue
    }
    const c = cardOf(n)
    if (c?.role?.id && !roles.has(c.role.id))
      roles.set(c.role.id, {
        id: c.role.id,
        name: c.role.name,
        color: c.role.color ?? null,
      })
    if (c?.type?.id && !types.has(c.type.id))
      types.set(c.type.id, {
        id: c.type.id,
        name: c.type.name ?? "",
        color: null,
      })
  }
  const list = (m: Map<string, LayerOption>, by: BandBy) =>
    [...m.values()]
      .map((o) => {
        const h = held[by].get(o.id)
        return h ? { ...o, held: h } : o
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      )
  return JSON.stringify({
    role: list(roles, "role"),
    device_type: list(types, "device_type"),
  })
}

/**
 * A row's Layers popover: the roles (as their badges) or device types
 * on the map, ticked for the ones the row holds. A tick takes effect at
 * once: a layer another row holds moves here, cards and all (that row is
 * named beside it).
 */
function LayersPicker({
  rule,
  band,
  onPick,
}: {
  rule: BandData["rule"]
  band: string
  onPick: (by: BandBy, ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [by, setBy] = useState<BandBy>(rule?.by ?? "role")
  useEffect(() => {
    if (open) setBy(rule?.by ?? "role")
  }, [open, rule?.by])
  const ids = rule?.by === by ? rule.ids : []
  const toggle = (id: string) =>
    onPick(by, ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolButton
          label="Layers"
          active={open}
          icon={<Layers className="size-3" />}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {open && (
          <LayerList
            band={band}
            by={by}
            ids={ids}
            onBy={setBy}
            onToggle={toggle}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function LayerList({
  band,
  by,
  ids,
  onBy,
  onToggle,
}: {
  band: string
  by: BandBy
  ids: readonly string[]
  onBy: (by: BandBy) => void
  onToggle: (id: string) => void
}) {
  const sig = useStore(useCallback((s) => optionsOf(s, band), [band]))
  const all = useMemo(
    () => JSON.parse(sig) as Record<BandBy, LayerOption[]>,
    [sig]
  )
  const options = all[by]
  return (
    <div className="flex flex-col">
      <SegmentedTabs
        className="border-b border-border p-1"
        items={[
          { value: "role", label: "Roles" },
          { value: "device_type", label: "Types" },
        ]}
        value={by}
        onValueChange={onBy}
      />
      <Command>
        {options.length > 8 && <CommandInput placeholder="Search…" />}
        <CommandList>
          <CommandEmpty>None on the map</CommandEmpty>
          <CommandGroup>
            {options.map((o) => {
              const on = ids.includes(o.id)
              return (
                <CommandItem
                  key={o.id}
                  value={o.id}
                  keywords={[o.name]}
                  data-checked={on}
                  onSelect={() => onToggle(o.id)}
                >
                  {by === "role" ? (
                    <ColorBadge name={o.name} color={o.color ?? undefined} />
                  ) : (
                    <span className="truncate">{o.name}</span>
                  )}
                  {o.held && !on && o.held !== o.name && (
                    <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
                      {o.held}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
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
 * current choice of a set (a note's size). Other props (a popover
 * trigger's) go to the button. */
export function ToolButton({
  label,
  icon,
  onClick,
  danger,
  active,
  ...rest
}: {
  label: string
  icon: React.ReactNode
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  danger?: boolean
  active?: boolean
} & Omit<React.ComponentProps<"button">, "onClick">) {
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      data-tip-plain=""
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
