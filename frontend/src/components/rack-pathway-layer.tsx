import { useQuery } from "@tanstack/react-query"
import { Cable, Pin } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ResolvedPathway, ResolvedPathways } from "@/lib/api"
import { useCableWaysFill } from "@/lib/cable-ways-pref"
import {
  KIND_LABEL,
  SUBKIND_LABEL,
  addPreset,
  dragSpan,
  isOwn,
  onFace,
  resetPayload,
  sideLanes,
  sizeText,
  span,
  unitsText,
  whereText,
} from "@/lib/rack-pathways"
import type { ElevationFace, PathwayForm } from "@/lib/rack-pathways"
import { pathwayFills } from "@/components/floorplan3d/way-geometry"
import type { SceneRack } from "@/components/floorplan3d/world"
import { SourceBadge } from "@/components/columns/rack-pathway-columns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelRow, PanelShell } from "@/components/map-panel"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  PathwayEditor,
  pathwaysKey,
  usePathwayRights,
  usePathwayWrites,
} from "@/components/rack-pathways-pane"
import { cn } from "@/lib/utils"

// The rack's pathways on its 2D elevation (docs/dcim/racks.md → Pathways →
// On the elevation): vertical managers and 0U channels as bars in a strip
// beside the rails, horizontal managers in their units, roof and floor
// entries as marks above and below the units. A press opens the pathway in
// the panel beside the faces; a press on an empty spot adds one there; a
// bar's ends and a horizontal manager drag to other units. Every write is
// the Pathways tab's (`/api/rack-pathways/`): an inherited pathway changes
// through its overlay row.

/** What the elevation's panel shows: a pathway, by key, or a new one with
 * these fields filled in. */
export type PathwayTarget = { key: string } | { preset: Partial<PathwayForm> }

/** The rack page hands this to both faces when the layer is on. */
export interface PathwayLayer {
  /** The pathway the panel shows. */
  selected: string | null
  onOpen: (target: PathwayTarget) => void
}

const ENDPOINT = "/api/rack-pathways/"

/** The rack's merged pathways - the Pathways tab's query, one cache entry. */
export function useRackPathways(rackId: string, enabled = true) {
  return useQuery({
    queryKey: pathwaysKey({ rackId }),
    queryFn: () => api<ResolvedPathways>(`${ENDPOINT}resolved/?rack=${rackId}`),
    enabled,
  })
}

/** Each manager's and entry's fill colour when the viewer's Fill overlay
 * is on (the 3D views' choice), from the rack's recorded ways as its 3D
 * view has them; null otherwise, and the bars stay neutral. */
export function usePathwayFills(
  rackId: string,
  enabled: boolean
): Map<string, string> | null {
  const fill = useCableWaysFill()
  const scene = useQuery({
    queryKey: ["rack-scene", rackId],
    queryFn: () => api<SceneRack>(`/api/racks/${rackId}/scene/`),
    staleTime: 30_000,
    enabled: enabled && fill,
  })
  return useMemo(() => {
    const s = scene.data
    if (!enabled || !fill || !s?.pathways) return null
    return pathwayFills(
      new Map(s.pathways.map((p) => [p.key, p])),
      s.ways ?? []
    )
  }, [enabled, fill, scene.data])
}

/** A drag over the units: the unit under the pointer as it moves, and where
 * it is let go (null when it never moved past `threshold` - a press). */
export function startUnitDrag(
  e: ReactPointerEvent,
  grid: HTMLElement | null,
  units: number[],
  rowHeight: number,
  on: {
    threshold?: number
    move: (unit: number) => void
    drop: (unit: number | null) => void
  }
) {
  if (!grid || e.button !== 0) return
  const startY = e.clientY
  const threshold = on.threshold ?? 0
  let active = threshold === 0
  const unitAt = (y: number) => {
    const top = grid.getBoundingClientRect().top
    const i = Math.floor((y - top) / rowHeight)
    return units[Math.min(units.length - 1, Math.max(0, i))]
  }
  const move = (ev: PointerEvent) => {
    if (!active && Math.abs(ev.clientY - startY) < threshold) return
    active = true
    on.move(unitAt(ev.clientY))
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    on.drop(active ? unitAt(ev.clientY) : null)
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
}

/** One pathway's short name on the elevation: its type, else its kind. */
export function shortKind(p: ResolvedPathway): string {
  if (p.kind === "channel") return "0U"
  return p.subkind ? SUBKIND_LABEL[p.subkind] : KIND_LABEL[p.kind]
}

/** Inherited and with this rack's row: pinned (a device or a cable way may
 * point at it). */
const pinned = (p: ResolvedPathway) => !!p.id && !isOwn(p, "rack")

function PathwayTip({
  p,
  children,
}: {
  p: ResolvedPathway
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" variant="default">
        {p.label}
        {p.u_from != null && ` · ${unitsText(p)}`}
      </TooltipContent>
    </Tooltip>
  )
}

/** The rack's writes a drag on the elevation makes: the changed units, on
 * the pathway's own row or its overlay. */
export function usePathwayMove(rackId: string) {
  const { overlay } = usePathwayWrites({ rackId })
  return (
    p: ResolvedPathway,
    body: { u_from?: number; u_to?: number },
    done: () => void
  ) =>
    overlay.mutate(
      { p, body },
      {
        onSuccess: () =>
          toast.success(`${p.label} → ${unitsText({ ...p, ...body })}`),
        onSettled: done,
      }
    )
}

const LANE_PX = 18
/** The empty lane at a strip's outer edge where who may add presses. */
const ADD_PX = 12

/** One side's strip beside the rails: its vertical managers and 0U channels
 * at their units, and - for who may add - a press on an empty unit adds
 * one there. */
export function PathwayStrip({
  side,
  face,
  items,
  units,
  rowHeight,
  first,
  last,
  descUnits,
  layer,
  fills,
  rackId,
}: {
  side: "left" | "right"
  face: ElevationFace
  items: ResolvedPathway[]
  /** The units top to bottom, as the grid draws them. */
  units: number[]
  rowHeight: number
  first: number
  last: number
  descUnits: boolean
  layer: PathwayLayer
  fills: Map<string, string> | null
  rackId: string
}) {
  const rights = usePathwayRights("rack")
  const move = usePathwayMove(rackId)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragged = useRef(false)
  const [preview, setPreview] = useState<{
    key: string
    lo: number
    hi: number
  } | null>(null)
  const { lanes, placed } = sideLanes(items, side, face)
  // Who may add gets an empty lane at the outer edge, so a strip whose
  // managers run full height still has a spot to press.
  const addLane = rights.canAdd
  const cols = Math.max(addLane ? 0 : 1, lanes) + (addLane ? 1 : 0)
  const template = [
    ...Array.from({ length: cols - (addLane ? 1 : 0) }, () => `${LANE_PX}px`),
  ]
  if (addLane)
    if (side === "left") template.unshift(`${ADD_PX}px`)
    else template.push(`${ADD_PX}px`)
  const rowOf = (u: number) => units.indexOf(u) + 1

  const startEnd = (
    e: ReactPointerEvent,
    p: ResolvedPathway,
    end: "top" | "bottom"
  ) => {
    e.stopPropagation()
    e.preventDefault()
    const s = span(p)
    // The end drawn at the top is the high unit, unless units count down.
    const topIsHi = !descUnits
    const movesHi = (end === "top") === topIsHi
    const fixed = movesHi ? s.lo : s.hi
    startUnitDrag(e, gridRef.current, units, rowHeight, {
      move: (u) => {
        const n = dragSpan(fixed, u)
        setPreview({ key: p.key, lo: n.u_from, hi: n.u_to })
      },
      drop: (u) => {
        dragged.current = true
        if (u == null) return setPreview(null)
        const n = dragSpan(fixed, u)
        if (n.u_from === s.lo && n.u_to === s.hi) return setPreview(null)
        const clash = items.find(
          (o) =>
            o.key !== p.key &&
            o.kind === p.kind &&
            o.side === p.side &&
            onFace(o, face) &&
            (p.kind === "vertical" || o.depth_mm === p.depth_mm) &&
            facesMeet(o.face, p.face) &&
            span(o).lo <= n.u_to &&
            n.u_from <= span(o).hi
        )
        if (clash) {
          toast.error(`Overlaps ${clash.label}.`)
          return setPreview(null)
        }
        const body: { u_from?: number; u_to?: number } = {}
        if (n.u_from !== s.lo || p.u_from == null) body.u_from = n.u_from
        if (n.u_to !== s.hi || p.u_to == null) body.u_to = n.u_to
        setPreview({ key: p.key, lo: n.u_from, hi: n.u_to })
        move(p, body, () => setPreview(null))
      },
    })
  }

  return (
    <div
      ref={gridRef}
      data-pathway-strip={side}
      className="grid shrink-0"
      style={{
        gridTemplateRows: `repeat(${units.length}, ${rowHeight}px)`,
        gridTemplateColumns: template.join(" "),
      }}
    >
      {units.map((u, i) => (
        <div
          key={u}
          data-unit={u}
          aria-hidden
          onClick={
            rights.canAdd
              ? () =>
                  layer.onOpen({
                    preset: addPreset(items, side, face, u, first, last),
                  })
              : undefined
          }
          className={cn(
            "border-b border-dashed border-border/50 last:border-b-0",
            rights.canAdd && "cursor-pointer hover:bg-primary/10"
          )}
          style={{ gridRow: i + 1, gridColumn: "1 / -1" }}
        />
      ))}
      {addLane && (
        // The add lane, outlined so it reads as a place to press.
        <div
          aria-hidden
          className="pointer-events-none m-px rounded-sm border border-dashed border-border"
          style={{
            gridRow: "1 / -1",
            gridColumn: side === "left" ? 1 : cols,
          }}
        />
      )}
      {placed.map(({ p, lane }) => {
        const s =
          preview?.key === p.key ? { lo: preview.lo, hi: preview.hi } : span(p)
        const topRow = rowOf(descUnits ? s.lo : s.hi)
        const col = side === "left" ? cols - lane : lane + 1
        const fill = fills?.get(p.key)
        const editable = rights.canEdit(p)
        const style: CSSProperties = {
          gridRow: `${Math.max(1, topRow)} / span ${s.hi - s.lo + 1}`,
          gridColumn: col,
          ...(fill
            ? {
                borderColor: fill,
                backgroundColor: `color-mix(in srgb, ${fill} 22%, var(--card))`,
              }
            : {}),
        }
        return (
          <PathwayTip key={p.key} p={p}>
            <button
              type="button"
              data-pathway={p.key}
              aria-label={`${p.label} · ${unitsText({ u_from: s.lo, u_to: s.hi })}`}
              aria-pressed={layer.selected === p.key}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false
                  return
                }
                layer.onOpen({ key: p.key })
              }}
              className={cn(
                "group/pw relative z-10 mx-px flex flex-col items-center gap-1 overflow-hidden rounded-sm border py-1",
                fill ? "" : "border-border bg-muted",
                p.kind === "channel" && !fill && "border-dashed",
                "hover:border-primary focus-visible:outline-2 focus-visible:outline-ring",
                layer.selected === p.key &&
                  "border-primary ring-2 ring-primary/50"
              )}
              style={style}
            >
              <span
                className="truncate font-mono text-[10px] leading-none text-foreground"
                style={{ writingMode: "vertical-rl" }}
              >
                {shortKind(p)}
              </span>
              <span style={{ writingMode: "vertical-rl" }}>
                <SourceBadge
                  p={p}
                  className="h-auto w-4 px-0 py-1 text-[9px]"
                />
              </span>
              {pinned(p) && (
                <Pin
                  aria-label="Pinned"
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                />
              )}
              {editable &&
                (["top", "bottom"] as const).map((end) => (
                  <span
                    key={end}
                    data-end={end}
                    aria-hidden
                    onPointerDown={(e) => startEnd(e, p, end)}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      "absolute inset-x-0 h-2 cursor-ns-resize touch-none",
                      end === "top" ? "top-0" : "bottom-0",
                      "after:absolute after:inset-x-1 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 group-hover/pw:after:opacity-100",
                      end === "top" ? "after:top-0.5" : "after:bottom-0.5"
                    )}
                  />
                ))}
            </button>
          </PathwayTip>
        )
      })}
    </div>
  )
}

function facesMeet(a: string, b: string): boolean {
  return a === b || a === "full" || b === "full" || !a || !b
}

/** The horizontal managers on a face, in their units over the grid -
 * dashed and marked as pathways, never confusable with a device. One
 * without a device drags to free units. */
export function HorizontalPathways({
  face,
  items,
  units,
  rowHeight,
  descUnits,
  first,
  last,
  taken,
  layer,
  rackId,
  gridRef,
}: {
  face: ElevationFace
  items: ResolvedPathway[]
  units: number[]
  rowHeight: number
  descUnits: boolean
  first: number
  last: number
  /** The units devices take on this face. */
  taken: Set<number>
  layer: PathwayLayer
  rackId: string
  gridRef: React.RefObject<HTMLDivElement | null>
}) {
  const rights = usePathwayRights("rack")
  const move = usePathwayMove(rackId)
  const dragged = useRef(false)
  const [preview, setPreview] = useState<{ key: string; lo: number } | null>(
    null
  )
  const mine = items.filter((p) => p.kind === "horizontal" && onFace(p, face))
  const rowOf = (u: number) => units.indexOf(u) + 1

  const start = (e: ReactPointerEvent, p: ResolvedPathway) => {
    const s = span(p)
    const h = s.hi - s.lo + 1
    const loOf = (u: number) => (descUnits ? u : u - (h - 1))
    startUnitDrag(e, gridRef.current, units, rowHeight, {
      threshold: 6,
      move: (u) => setPreview({ key: p.key, lo: loOf(u) }),
      drop: (u) => {
        if (u == null) return
        dragged.current = true
        const lo = loOf(u)
        if (lo === s.lo) return setPreview(null)
        if (lo < first || lo + h - 1 > last) {
          toast.error("Doesn't fit there - runs past the rack.")
          return setPreview(null)
        }
        const span2 = Array.from({ length: h }, (_, i) => lo + i)
        const other = mine.some(
          (o) => o.key !== p.key && span(o).lo <= lo + h - 1 && lo <= span(o).hi
        )
        if (other || span2.some((x) => taken.has(x))) {
          toast.error("That space is occupied.")
          return setPreview(null)
        }
        setPreview({ key: p.key, lo })
        move(p, { u_from: lo, u_to: lo + h - 1 }, () => setPreview(null))
      },
    })
  }

  return (
    <>
      {mine.map((p) => {
        const s = span(p)
        const h = s.hi - s.lo + 1
        const lo = preview?.key === p.key ? preview.lo : s.lo
        const top = rowOf(descUnits ? lo : lo + h - 1)
        if (top < 1) return null
        const canMove = rights.canEdit(p) && !p.device
        return (
          <PathwayTip key={p.key} p={p}>
            <button
              type="button"
              data-pathway={p.key}
              aria-label={`${p.label} · ${unitsText({ u_from: lo, u_to: lo + h - 1 })}`}
              aria-pressed={layer.selected === p.key}
              onPointerDown={canMove ? (e) => start(e, p) : undefined}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false
                  return
                }
                layer.onOpen({ key: p.key })
              }}
              className={cn(
                "relative z-20 m-px flex items-center gap-1.5 overflow-hidden rounded-sm border border-dashed border-muted-foreground/60 bg-muted px-2 text-left text-[11px] text-muted-foreground",
                canMove && "cursor-grab touch-none active:cursor-grabbing",
                "hover:border-primary focus-visible:outline-2 focus-visible:outline-ring",
                layer.selected === p.key &&
                  "border-primary ring-2 ring-primary/50"
              )}
              style={{
                gridRow: `${top} / span ${h}`,
                gridColumn: "1 / -1",
              }}
            >
              <Cable className="h-3 w-3 shrink-0" />
              <span className="truncate font-medium text-foreground">
                {shortKind(p)}
              </span>
              <span className="truncate">{p.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {pinned(p) && <Pin aria-label="Pinned" className="h-3 w-3" />}
                <SourceBadge p={p} />
              </span>
            </button>
          </PathwayTip>
        )
      })}
    </>
  )
}

/** The roof's or the floor's entries, as marks across the top or the foot
 * of the units at their place (`x_mm` from the centre); a press on the
 * empty roof or floor adds one there. */
export function EntryMarks({
  surface,
  items,
  pxPerMm,
  layer,
  fills,
}: {
  surface: "top" | "bottom"
  items: ResolvedPathway[]
  pxPerMm: number
  layer: PathwayLayer
  fills: Map<string, string> | null
}) {
  const rights = usePathwayRights("rack")
  const mine = items.filter(
    (p) => p.kind === "entry" && p.surface === surface && !p.hidden && !p.orphan
  )
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      data-entries={surface}
      aria-hidden={mine.length === 0 || undefined}
      onClick={
        rights.canAdd
          ? (e) => {
              if (e.target !== e.currentTarget) return
              const r = e.currentTarget.getBoundingClientRect()
              const x = Math.round(
                (e.clientX - (r.left + r.width / 2)) / pxPerMm
              )
              layer.onOpen({
                preset: {
                  kind: "entry",
                  surface,
                  x_mm: Number.isFinite(x) ? String(x) : "",
                },
              })
            }
          : undefined
      }
      className={cn(
        "absolute inset-x-0 h-3.5 rounded-sm border border-dashed border-border/70",
        surface === "top" ? "-top-[18px]" : "-bottom-[18px]",
        rights.canAdd && "cursor-pointer hover:bg-primary/10"
      )}
    >
      {mine.map((p) => {
        const w = Math.max(10, (p.inner_w_mm ?? 120) * pxPerMm)
        const x = (p.x_mm ?? 0) * pxPerMm
        const fill = fills?.get(p.key)
        return (
          <PathwayTip key={p.key} p={p}>
            <button
              type="button"
              data-pathway={p.key}
              aria-label={p.label}
              aria-pressed={layer.selected === p.key}
              onClick={() => layer.onOpen({ key: p.key })}
              className={cn(
                "absolute inset-y-0.5 rounded-[3px] border",
                fill ? "" : "border-muted-foreground/60 bg-muted",
                "hover:border-primary focus-visible:outline-2 focus-visible:outline-ring",
                layer.selected === p.key &&
                  "border-primary ring-2 ring-primary/50"
              )}
              style={{
                left: `calc(50% + ${x - w / 2}px)`,
                width: w,
                ...(fill
                  ? {
                      borderColor: fill,
                      backgroundColor: `color-mix(in srgb, ${fill} 30%, var(--card))`,
                    }
                  : {}),
              }}
            />
          </PathwayTip>
        )
      })}
    </div>
  )
}

/** The panel beside the faces: the pathway pressed - its form for who may
 * edit it, else what it is - or the form for a new one. */
export function PathwayPanel({
  rackId,
  target,
  onClose,
  onSelect,
}: {
  rackId: string
  target: PathwayTarget
  onClose: () => void
  onSelect: (key: string) => void
}) {
  const q = useRackPathways(rackId)
  const rights = usePathwayRights("rack")
  const { overlay, remove } = usePathwayWrites({ rackId })
  const owner = useMemo(() => ({ rackId }), [rackId])
  const key = "key" in target ? target.key : null
  const p = key ? (q.data?.items.find((i) => i.key === key) ?? null) : null
  const preset = "preset" in target ? target.preset : undefined

  const shell = (
    title: string,
    body: React.ReactNode,
    footer?: React.ReactNode
  ) => (
    <PanelShell label="Pathway" title={title} onClose={onClose} footer={footer}>
      {body}
    </PanelShell>
  )

  if (q.isLoading) return shell("Pathway", <Loading />)
  if (q.isError) return shell("Pathway", <QueryError error={q.error} />)
  const doc = q.data
  if (!doc) return null
  if (key && !p)
    return shell(
      "Pathway",
      <p className="text-muted-foreground">Not on this rack.</p>
    )

  if (!p) {
    if (!rights.canAdd) return null
    return shell(
      "Add pathway",
      <PathwayEditor
        key={JSON.stringify(preset ?? {})}
        owner={owner}
        level="rack"
        pathway={null}
        preset={preset}
        defaultFill={doc.fill_limit_pct}
        compact
        onCancel={onClose}
        onSaved={(row) => onSelect(`manual:${row.id}`)}
      />
    )
  }

  const footer =
    rights.canOverlay(p) || rights.canRemove(p) ? (
      <>
        {rights.canOverlay(p) && p.id && p.overridden.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={overlay.isPending}
            onClick={() => overlay.mutate({ p, body: resetPayload() })}
          >
            Reset
          </Button>
        )}
        {rights.canOverlay(p) && (
          <Button
            size="sm"
            variant="outline"
            disabled={overlay.isPending}
            onClick={() =>
              overlay.mutate(
                { p, body: { hidden: !p.hidden } },
                { onSuccess: onClose }
              )
            }
          >
            {p.hidden ? "Show" : "Hide"}
          </Button>
        )}
        {rights.canRemove(p) && (
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => p.id && remove.mutate(p.id, { onSuccess: onClose })}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        )}
      </>
    ) : undefined

  return shell(
    p.label,
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <SourceBadge p={p} />
        {p.overridden.length > 0 && <Badge variant="outline">Changed</Badge>}
        {pinned(p) && (
          <Badge variant="outline">
            <Pin /> Pinned
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {KIND_LABEL[p.kind]}
        </span>
      </div>
      {rights.canEdit(p) ? (
        <PathwayEditor
          key={p.key}
          owner={owner}
          level="rack"
          pathway={p}
          defaultFill={doc.fill_limit_pct}
          compact
          onCancel={onClose}
          onSaved={() => undefined}
        />
      ) : (
        <PathwayFacts p={p} />
      )}
    </>,
    footer
  )
}

/** What a pathway is, for who may not change it. */
function PathwayFacts({ p }: { p: ResolvedPathway }) {
  return (
    <>
      {p.subkind && (
        <PanelRow label="Type">{SUBKIND_LABEL[p.subkind]}</PanelRow>
      )}
      {whereText(p) && <PanelRow label="Where">{whereText(p)}</PanelRow>}
      {p.u_from != null && (
        <PanelRow label="Units">
          <span className="num">{unitsText(p)}</span>
        </PanelRow>
      )}
      {sizeText(p) && (
        <PanelRow label="Inner size">
          <span className="num">{sizeText(p)}</span>
        </PanelRow>
      )}
      {p.kind !== "channel" && (
        <PanelRow label="Fill limit">
          <span className="num">{p.fill_limit_pct} %</span>
        </PanelRow>
      )}
      {p.accessory_type && (
        <PanelRow label="Model">{p.accessory_type.name}</PanelRow>
      )}
      {p.device && <PanelRow label="Device">{p.device.name}</PanelRow>}
      {p.cables != null && (
        <PanelRow label="Cables">
          <span className="num">{p.cables}</span>
        </PanelRow>
      )}
      {p.description && (
        <p className="mt-2 text-muted-foreground">{p.description}</p>
      )}
    </>
  )
}
