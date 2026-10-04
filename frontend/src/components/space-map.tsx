import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { SegmentedTabs } from "@/components/segmented-tabs"

import { api } from "@/lib/api"
import type {
  SpaceMap as SpaceMapData,
  SpaceMapCell,
  SpaceMapCellState,
  SpaceMapRow,
  SpaceMapRun,
  SpaceMapSpan,
} from "@/lib/api"
import {
  blockAt,
  cellActions,
  cellNote,
  holdsBlock,
  runAt,
  supernetOf,
} from "@/lib/space-map"
import type { SpaceMapAction } from "@/lib/space-map"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SpaceMapProps {
  /** Parent prefix UUID - the map is fetched + IP/child create attach to it. */
  prefixId: string
  /** VRF UUID for the parent prefix - pre-fills the create page when the
   * user clicks a free cell. NULL = Global VRF. */
  vrfId?: string | null
  /** The prefix's own CIDR - the breadcrumb root. */
  rootCidr: string
  /** The zoom path, outermost first. The caller owns it - the prefix page
   * keeps it in the URL, so Back, a reload or a link lands on the same view. */
  zoom: string[]
  onZoomChange: (zoom: string[]) => void
  /** Offer "New child prefix here" / "Register an IP here" (RBAC). */
  canAddPrefix?: boolean
  canAddIp?: boolean
  /** Where the create forms return to after saving (this map, zoom kept). */
  returnTo?: string
  /** The view's own block when it isn't the prefix itself - zoomed out to a
   * block holding the page's prefix: the map is fetched within it. */
  rootWithin?: string
  /** Blocks on the trail before the root - the masters holding it,
   * outermost first; picking one zooms out to it. */
  lead?: TrailBlock[]
  /** Zoom out one bit from the root; absent when the root is as far out as
   * this map goes. */
  onZoomOut?: () => void
  /** Every size the map can zoom out to, outermost first (the ▾ menu). */
  levels?: (TrailBlock & { current: boolean; label?: string })[]
  /** The page's own prefix: outlined where the map shows it, and picking it
   * returns to it. */
  focus?: TrailBlock
}

/** A block on the zoom trail, and what picking it does. */
export interface TrailBlock {
  cidr: string
  onSelect: () => void
}

// Visual subnet map for a prefix (IPv4 or IPv6). Each aligned subnet inside the
// prefix gets a cell, classified by the API:
//
//   free    → emerald - allocatable (a count badge when stray IPs sit in it,
//             an amber strip where an IP range does).
//   partial → emerald with rose bars where smaller child prefixes sit; the
//             block can't be allocated whole, but has room one level down.
//   full    → rose - inside, or exactly, a child prefix.
//
// A cell with one action runs it on click (a partly used cell zooms in); one
// with several opens a menu (lib/space-map.ts holds the rules). The zoom path
// re-roots the map at a cell, which is also how the map goes past the +8-bit
// row cap: a /18 draws down to /26, and zooming carries on from there.
export function SpaceMap({
  prefixId,
  vrfId = null,
  rootCidr,
  zoom,
  onZoomChange,
  canAddPrefix = true,
  canAddIp = true,
  returnTo,
  rootWithin,
  lead = [],
  onZoomOut,
  levels = [],
  focus,
}: SpaceMapProps) {
  const nav = useNavigate()
  const { values, setPref } = useUserPrefs()
  const layout: SpaceMapLayout =
    values.space_map_layout === "aligned" ? "aligned" : "grid"
  const v4Max = Number(values.space_map_v4_max ?? 31)
  const v6Max = Number(values.space_map_v6_max ?? 128)
  const current = zoom.at(-1)
  const within = current ?? rootWithin

  // After a zoom the clicked cell is gone; keep keyboard focus in the map.
  const rootRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const zoomKey = zoom.join(",")
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    rootRef.current?.focus()
  }, [zoomKey])
  function zoomTo(next: string[]) {
    refocus.current = true
    onZoomChange(next)
  }

  // The map's width: in the aligned layout a cell shows its label only when
  // the whole label fits - a cut "10.0.112.0/2" reads as another network.
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width)
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Rows past the +8 window asked for with "Show /25", for this view only.
  const viewKey = `${prefixId}|${within ?? ""}`
  const [deep, setDeep] = useState({ at: "", n: 0 })
  const deeper = deep.at === viewKey ? deep.n : 0
  const space = useQuery({
    queryKey: [
      "prefix-space-map",
      prefixId,
      within ?? "",
      v4Max,
      v6Max,
      deeper,
    ],
    queryFn: () => {
      const p = new URLSearchParams({
        v4_max: String(v4Max),
        v6_max: String(v6Max),
        details: "0",
      })
      if (within) p.set("within", within)
      if (deeper) p.set("deeper", String(deeper))
      return api<SpaceMapData>(
        `/api/prefixes/${prefixId}/space-map/?${p.toString()}`
      )
    },
    // Keep the rows on screen while the next one loads.
    placeholderData: (prev) =>
      prev && prev.root === (within ?? rootCidr) ? prev : undefined,
  })
  const data = space.data
  // The most specific prefix holding the view: free blocks belong to it.
  const context = data?.context ?? null

  function gotoCreatePrefix(cidr: string) {
    nav({
      to: "/prefixes/new",
      search: {
        cidr,
        vrf: vrfId ?? undefined,
        site: undefined,
        location: undefined,
        ...(returnTo ? { from: returnTo } : {}),
      },
    })
  }
  function gotoCreateIp(cidr: string) {
    nav({
      to: "/ips/new",
      search: {
        address: firstHost(cidr),
        prefix: context?.id ?? prefixId,
        ...(returnTo ? { from: returnTo } : {}),
      },
    })
  }

  let body: ReactElement | null = null
  if (space.isLoading) body = <Loading />
  else if (space.isError) body = <QueryError error={space.error} />
  else if (data && !data.supported)
    body = (
      <EmptyState title="Nothing to subdivide">
        A map needs IPv4 /30 or shorter, IPv6 /127 or shorter.
      </EmptyState>
    )
  else if (data && data.rows.length === 0)
    body = <EmptyState title="No aligned subnets to show" />
  else if (data)
    body = (
      <>
        {data.rows.map((row) =>
          row.runs ? (
            <RunRow
              key={row.prefixlen}
              row={row}
              runs={row.runs}
              root={data.root ?? current ?? rootCidr}
              onZoom={(cidr) => zoomTo([...zoom, cidr])}
            />
          ) : (
            <section key={row.prefixlen}>
              <RowHeading row={row} />
              <div
                className={cn(
                  "grid",
                  layout === "aligned" ? "gap-px" : "gap-1"
                )}
                style={{
                  gridTemplateColumns: `repeat(${rowColumns(layout, row.count)}, minmax(0, 1fr))`,
                }}
              >
                {row.cells.map((cell) => (
                  <Cell
                    key={cell.cidr}
                    cell={cell}
                    fit={cellFit(
                      layout,
                      row.count,
                      width,
                      labelChars(row.cells)
                    )}
                    actions={cellActions(cell, {
                      allowPrefix: canAddPrefix,
                      allowIp: canAddIp,
                    })}
                    onZoom={() => zoomTo([...zoom, cell.cidr])}
                    focused={
                      !focus
                        ? false
                        : focus.cidr === cell.cidr
                          ? "self"
                          : holdsBlock(cell.cidr, focus.cidr)
                            ? "holder"
                            : false
                    }
                    onFocusSelect={
                      focus?.cidr === cell.cidr ? focus.onSelect : undefined
                    }
                    onCreatePrefix={() => gotoCreatePrefix(cell.cidr)}
                    onCreateIp={() => gotoCreateIp(cell.cidr)}
                  />
                ))}
              </div>
            </section>
          )
        )}
        {data.more && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={space.isFetching}
              onClick={() => setDeep({ at: viewKey, n: deeper + 1 })}
            >
              {space.isFetching && space.isPlaceholderData
                ? "Loading…"
                : `Show /${data.more.prefixlen} (${data.more.count.toLocaleString()})`}
            </Button>
          </div>
        )}
      </>
    )

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label={`Space map of ${current ?? rootCidr}`}
      className="flex flex-col gap-6 outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedTabs
            items={LAYOUTS}
            value={layout}
            onValueChange={(v) => setPref("space_map_layout", v)}
          />
          <Legend />
        </div>
        {(zoom.length > 0 || lead.length > 0 || levels.length > 1) && (
          <ZoomTrail
            root={rootCidr}
            steps={zoom}
            holder={context}
            lead={lead}
            levels={levels}
            onZoomOut={onZoomOut}
            onJump={(depth) => zoomTo(zoom.slice(0, depth))}
          />
        )}
      </div>
      {body}
    </div>
  )
}

/** A row's counts: free of all, partly used, stray IPs, IP ranges - and,
 * on a deep row, the subnet under the pointer. */
function RowHeading({
  row,
  extra,
}: {
  row: SpaceMapRow
  extra?: ReactElement | null
}) {
  return (
    <h3 className="mb-2 text-xs font-medium">
      <span className="num">
        {row.free_count.toLocaleString()}/{row.count.toLocaleString()}
      </span>{" "}
      free <span className="font-mono">/{row.prefixlen}</span> subnets
      {row.partial_count > 0 && (
        <span className="ml-2 font-normal text-muted-foreground">
          · <span className="num">{row.partial_count}</span> partly used
        </span>
      )}
      {row.dirty_count > 0 && (
        <span className="ml-2 font-normal text-muted-foreground">
          · <span className="num">{row.dirty_count}</span> contain
          {row.dirty_count === 1 ? "s" : ""} stray IP
          {row.dirty_count === 1 ? "" : "s"}
        </span>
      )}
      {row.ranged_count > 0 && (
        <span className="ml-2 font-normal text-muted-foreground">
          · <span className="num">{row.ranged_count}</span>{" "}
          {row.ranged_count === 1 ? "holds an IP range" : "hold IP ranges"}
        </span>
      )}
      {extra}
    </h3>
  )
}

const RUN_NOTE: Record<SpaceMapCellState, string> = {
  free: "free",
  partial: "partly used",
  full: "used",
}

/**
 * A row past the +8 window - up to 65,536 subnets - as one strip: the
 * stretches that are used, partly used, hold stray IPs or IP ranges drawn
 * where they sit, the rest the free green. Point at it (or move with the
 * arrow keys) for the subnet there; a click or Enter zooms in so that
 * subnet becomes a cell of its own.
 */
function RunRow({
  row,
  runs,
  root,
  onZoom,
}: {
  row: SpaceMapRow
  runs: SpaceMapRun[]
  root: string
  onZoom: (cidr: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<number | null>(null)
  const pct = (n: number) => `${(n / row.count) * 100}%`
  const indexAt = (x: number) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return 0
    const i = Math.floor(((x - box.left) / box.width) * row.count)
    return Math.min(row.count - 1, Math.max(0, i))
  }
  const rootLen = Number(root.split("/")[1])
  const zoomTo = (i: number) => {
    const cell = blockAt(root, row.prefixlen, i)
    const target = supernetOf(cell, Math.max(rootLen + 1, row.prefixlen - 8))
    if (target) onZoom(target)
  }
  const run = at === null ? null : runAt(runs, at)
  const step = Math.max(1, Math.round(row.count / 64))
  return (
    <section>
      <RowHeading
        row={row}
        extra={
          at === null ? null : (
            <span className="ml-2 font-normal text-muted-foreground">
              ·{" "}
              <span className="font-mono text-foreground">
                {blockAt(root, row.prefixlen, at)}
              </span>{" "}
              {run ? RUN_NOTE[run[2]] : ""}
              {run?.[5] && run[2] === "full" ? ` in ${run[5]}` : ""}
              {run?.[3] ? ", stray IPs" : ""}
              {run?.[4] ? ", IP range" : ""}
            </span>
          )
        }
      />
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label={`/${row.prefixlen} subnets: point or use the arrow keys, Enter zooms in`}
        className={cn(
          "relative h-7 cursor-pointer overflow-hidden rounded-md ring-1 ring-emerald-300 outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ring dark:ring-emerald-900",
          FREE_FILL
        )}
        onMouseMove={(e) => setAt(indexAt(e.clientX))}
        onMouseLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        onClick={(e) => zoomTo(indexAt(e.clientX))}
        onKeyDown={(e) => {
          const i = at ?? 0
          const by = e.shiftKey ? step : 1
          if (e.key === "ArrowRight") setAt(Math.min(row.count - 1, i + by))
          else if (e.key === "ArrowLeft") setAt(Math.max(0, i - by))
          else if (e.key === "Home") setAt(0)
          else if (e.key === "End") setAt(row.count - 1)
          else if (e.key === "Enter" || e.key === " ") zoomTo(i)
          else return
          e.preventDefault()
        }}
      >
        {runs.map((r) =>
          r[2] === "free" && !r[3] && !r[4] ? null : (
            <span
              key={r[0]}
              aria-hidden
              data-slot="run"
              className={cn(
                "pointer-events-none absolute inset-y-0",
                r[2] === "full" && USED_FILL,
                r[2] === "free" &&
                  r[3] &&
                  "bg-emerald-300/50 dark:bg-emerald-700/40"
              )}
              style={{
                left: pct(r[0]),
                width: pct(r[1] - r[0] + 1),
                minWidth: 1,
                ...(r[2] === "partial" ? HATCH_STYLE : {}),
              }}
            >
              {r[4] && <span className={cn(RANGE_STRIP, "inset-x-0")} />}
            </span>
          )
        )}
        {at !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 ring-2 ring-primary ring-inset"
            style={{ left: pct(at), width: pct(1), minWidth: 3 }}
          />
        )}
      </div>
    </section>
  )
}

// Zoom out one level, or jump to any block on the path. The last crumb is the
// block on screen; when that block is (or sits in) a child prefix, the prefix
// is one click away.
function ZoomTrail({
  root,
  steps,
  holder,
  lead,
  levels,
  onZoomOut,
  onJump,
}: {
  root: string
  steps: string[]
  holder: { id: string; cidr: string } | null
  lead: TrailBlock[]
  levels: (TrailBlock & { current: boolean; label?: string })[]
  onZoomOut?: () => void
  onJump: (depth: number) => void
}) {
  const trail = [root, ...steps]
  const here = steps.at(-1)
  // Out of a zoom first, then - on a prefix inside a master - out of the
  // prefix itself, one bit at a time.
  const canOut = steps.length > 0 || !!onZoomOut
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            disabled={!canOut}
            onClick={() =>
              steps.length > 0 ? onJump(steps.length - 1) : onZoomOut?.()
            }
          >
            <ZoomOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>
      {levels.length > 1 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Zoom to a size"
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Zoom to a size</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="max-h-(--radix-dropdown-menu-content-available-height) w-max overflow-y-auto"
          >
            {levels.map((l) => (
              <DropdownMenuItem key={l.cidr} onSelect={l.onSelect}>
                <Check
                  className={cn("h-3.5 w-3.5", !l.current && "invisible")}
                />
                <span className="font-mono text-xs">{l.cidr}</span>
                {l.label && (
                  <span className="text-xs text-muted-foreground">
                    {l.label}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {lead.map((b) => (
        <span key={b.cidr} className="contents">
          <button
            type="button"
            onClick={b.onSelect}
            className="link font-mono hover:text-foreground"
          >
            {b.cidr}
          </button>
          <ChevronRight className="h-3 w-3 opacity-60" />
        </span>
      ))}
      {trail.map((cidr, i) => (
        <span key={i} className="contents">
          {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
          {i < trail.length - 1 ? (
            <button
              type="button"
              onClick={() => onJump(i)}
              className="link font-mono hover:text-foreground"
            >
              {cidr}
            </button>
          ) : holder && holder.cidr === cidr ? (
            <Link
              to="/prefixes/$id"
              params={{ id: holder.id }}
              className="link font-mono font-medium text-foreground"
            >
              {cidr}
            </Link>
          ) : (
            <span className="font-mono font-medium text-foreground">
              {cidr}
            </span>
          )}
        </span>
      ))}
      {holder && holder.cidr !== here && (
        <span className="ml-1.5">
          in{" "}
          <Link
            to="/prefixes/$id"
            params={{ id: holder.id }}
            className="link font-mono hover:text-foreground"
          >
            {holder.cidr}
          </Link>
        </span>
      )}
    </div>
  )
}

// Best-effort first-host extraction for a CIDR string. Splits on "/" and
// returns the network address - the IP form will validate.
function firstHost(cidr: string): string {
  const slash = cidr.indexOf("/")
  return slash > 0 ? cidr.slice(0, slash) : cidr
}

type SpaceMapLayout = "grid" | "aligned"

const LAYOUTS = [
  { value: "grid", label: "Grid" },
  { value: "aligned", label: "Aligned" },
] as const

// Grid: up to 8 cells a line, every cell labelled. Aligned: a row's cells on
// one line, so each sits under the block it splits; one gap for every row
// keeps the edges lined up.
function rowColumns(layout: SpaceMapLayout, count: number) {
  if (layout === "aligned") return count
  return count <= 2 ? 2 : count <= 4 ? 4 : 8
}

/** How much a cell has room for: its label, a smaller label, or only its
 * colour (the tooltip names it). */
type CellFit = "label" | "small" | "bare"

function cellFit(
  layout: SpaceMapLayout,
  count: number,
  width: number,
  chars: number
): CellFit {
  if (layout === "grid") return "label"
  if (!width) return count <= 8 ? "label" : "bare"
  // One 1px gap between cells; a mono digit is about 0.62em wide.
  const cell = (width - (count - 1)) / count
  if (cell >= chars * 11 * 0.62 + 16) return "label"
  if (cell >= chars * 10 * 0.62 + 4) return "small"
  return "bare"
}

/** The longest label in a row, in characters. */
const labelChars = (cells: readonly { cidr: string }[]) =>
  Math.max(0, ...cells.map((c) => c.cidr.length))

const CELL_BASE =
  "relative block w-full overflow-hidden ring-1 ring-inset transition outline-none focus-visible:ring-2 focus-visible:ring-ring"
const CELL = `${CELL_BASE} rounded-md px-2 py-1.5 text-center font-mono text-[11px] font-medium`
const CELL_FIT: Record<CellFit, string> = {
  label: CELL,
  small: `${CELL_BASE} rounded-[4px] px-0.5 py-1.5 text-center font-mono text-[10px] font-medium whitespace-nowrap`,
  bare: `${CELL_BASE} h-7 min-w-0 rounded-[2px]`,
}

// One fill for "used", shared by full cells, the used part of a partly used
// cell and the legend, so a bar reads exactly as much used as a used cell.
const USED_FILL = "bg-rose-100 dark:bg-rose-950/40"
const FREE_FILL = "bg-emerald-100 dark:bg-emerald-950/40"

const TONE: Record<SpaceMapCellState, string> = {
  free: `cursor-pointer ${FREE_FILL} text-emerald-700 ring-emerald-200 hover:bg-emerald-200 hover:ring-emerald-400 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-900/50 dark:hover:ring-emerald-700`,
  partial: `cursor-pointer ${FREE_FILL} text-foreground ring-rose-300 hover:bg-emerald-200 hover:ring-rose-400 dark:ring-rose-800 dark:hover:bg-emerald-900/50 dark:hover:ring-rose-600`,
  full: `cursor-pointer ${USED_FILL} text-rose-700 ring-rose-200 hover:bg-rose-200 hover:ring-rose-400 dark:text-rose-300 dark:ring-rose-900 dark:hover:bg-rose-900/50 dark:hover:ring-rose-700`,
}

// An IP range: a strip along the bottom edge, where the range sits.
const RANGE_STRIP =
  "pointer-events-none absolute bottom-0 h-[3px] bg-amber-500/80 dark:bg-amber-400/70"

// Where a span sits in its cell. Anchored to the nearer edge, so the 3px
// floor grows inward and a sliver at the end of the block isn't clipped.
function spanStyle([start, end]: SpaceMapSpan) {
  return {
    ...(start < 1 - end
      ? { left: `${start * 100}%` }
      : { right: `${(1 - end) * 100}%` }),
    width: `${(end - start) * 100}%`,
    minWidth: 3,
  }
}

// A partly used cell's used stretches run its full height: solid where a
// child prefix fills the stretch, hatched where it still has free gaps. Its
// outline is drawn again over them (PARTIAL_EDGE) - under them it broke into
// pieces that read as a rendering glitch.
const HATCH_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgb(244 63 94 / 0.5) 0 2px, transparent 2px 5px)",
}
const PARTIAL_EDGE =
  "pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-rose-400 ring-inset dark:ring-rose-600"

function CellFace({ cell, fit }: { cell: SpaceMapCell; fit: CellFit }) {
  return (
    <>
      {cell.state === "partial" &&
        cell.used_spans.map((span, i) =>
          span[2] >= 1 ? (
            // On the page background, so the translucent dark-mode fill
            // reads exactly like a used cell, not mixed with the green.
            <span
              key={i}
              aria-hidden
              data-slot="used-span"
              className="pointer-events-none absolute inset-y-0 bg-background"
              style={spanStyle(span)}
            >
              <span className={cn("absolute inset-0", USED_FILL)} />
            </span>
          ) : (
            <span
              key={i}
              aria-hidden
              data-slot="used-span"
              className="pointer-events-none absolute inset-y-0"
              style={{ ...spanStyle(span), ...HATCH_STYLE }}
            />
          )
        )}
      {cell.state === "partial" && (
        <span aria-hidden className={PARTIAL_EDGE} />
      )}
      {cell.state !== "full" &&
        cell.range_spans.map((span, i) => (
          <span
            key={`r${i}`}
            aria-hidden
            data-slot="range-span"
            className={RANGE_STRIP}
            style={spanStyle(span)}
          />
        ))}
      {/* A marker behind the label must not break up its digits. */}
      {fit !== "bare" && (
        <span
          className={cn(
            "relative",
            cell.state === "partial" &&
              "[text-shadow:0_0_3px_var(--background),0_0_2px_var(--background)]"
          )}
        >
          {cell.cidr}
        </span>
      )}
      {cell.dirty && fit !== "bare" && (
        <span className="num absolute top-[2px] right-[3px] inline-flex h-[10px] min-w-[10px] items-center justify-center px-[2px] text-[8px] leading-none font-semibold text-emerald-700/55 dark:text-emerald-300/60">
          {cell.ip_count}
        </span>
      )}
    </>
  )
}

function Cell({
  cell,
  fit,
  actions,
  onZoom,
  focused = false,
  onFocusSelect,
  onCreatePrefix,
  onCreateIp,
}: {
  cell: SpaceMapCell
  fit: CellFit
  actions: SpaceMapAction[]
  onZoom: () => void
  /** The page's own prefix ("self": outlined, and "Open" returns to it), or
   * a block holding it ("holder": a dashed outline to follow down). */
  focused?: "self" | "holder" | false
  onFocusSelect?: () => void
  onCreatePrefix: () => void
  onCreateIp: () => void
}) {
  const note = cellNote(cell)
  const label = `${cell.cidr}, ${note}`
  const cls = cn(
    CELL_FIT[fit],
    TONE[cell.state],
    focused === "self" &&
      "outline-2 outline-offset-2 outline-primary outline-solid",
    focused === "holder" &&
      "outline-1 outline-offset-1 outline-primary/70 outline-dashed"
  )
  const face = <CellFace cell={cell} fit={fit} />
  const run = (action: SpaceMapAction) => {
    if (action.kind === "zoom") onZoom()
    else if (action.kind === "new-prefix") onCreatePrefix()
    else if (action.kind === "new-ip") onCreateIp()
  }
  const tip = (trigger: ReactElement) => (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent className="max-w-none flex-col items-start gap-0.5 whitespace-nowrap">
        <span className="font-mono font-medium">{cell.cidr}</span>
        <span>{note}</span>
      </TooltipContent>
    </Tooltip>
  )

  if (actions.length === 0) {
    return tip(
      <span
        tabIndex={0}
        aria-label={label}
        className={cn(cls, "cursor-default")}
      >
        {face}
      </span>
    )
  }

  if (actions.length === 1) {
    const [only] = actions
    if (only.kind === "open" && onFocusSelect) {
      return tip(
        <button
          type="button"
          aria-label={label}
          className={cls}
          onClick={onFocusSelect}
        >
          {face}
        </button>
      )
    }
    if (only.kind === "open") {
      return tip(
        <Link
          to="/prefixes/$id"
          params={{ id: only.prefix.id }}
          aria-label={label}
          className={cls}
        >
          {face}
        </Link>
      )
    }
    return tip(
      <button
        type="button"
        aria-label={label}
        className={cls}
        onClick={() => run(only)}
      >
        {face}
      </button>
    )
  }

  return (
    <DropdownMenu>
      {tip(
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={label} className={cls}>
            {face}
          </button>
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" className="w-max min-w-56">
        {actions.map((action) =>
          action.kind === "open" && onFocusSelect ? (
            <DropdownMenuItem key="open" onSelect={onFocusSelect}>
              <ArrowUpRight className="h-3.5 w-3.5" />
              <MenuLabel verb="Back to" cidr={action.prefix.cidr} />
            </DropdownMenuItem>
          ) : action.kind === "open" ? (
            <DropdownMenuItem key="open" asChild>
              <Link to="/prefixes/$id" params={{ id: action.prefix.id }}>
                <ArrowUpRight className="h-3.5 w-3.5" />
                <MenuLabel verb="Open" cidr={action.prefix.cidr} />
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={action.kind} onSelect={() => run(action)}>
              {action.kind === "zoom" ? (
                <>
                  <ZoomIn className="h-3.5 w-3.5" />
                  <MenuLabel verb="Zoom into" cidr={action.cidr} />
                </>
              ) : action.kind === "new-prefix" ? (
                <>
                  <Plus className="h-3.5 w-3.5" /> New child prefix here
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" /> Register an IP here
                </>
              )}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// One line, however long the CIDR (an IPv6 one is).
function MenuLabel({ verb, cidr }: { verb: string; cidr: string }) {
  return (
    <span className="whitespace-nowrap">
      {verb} <span className="font-mono text-xs">{cidr}</span>
    </span>
  )
}

function Legend() {
  const swatch = "relative h-3 w-5 overflow-hidden rounded-sm ring-1 ring-inset"
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            swatch,
            FREE_FILL,
            "ring-emerald-300 dark:ring-emerald-800"
          )}
        />
        free
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            swatch,
            FREE_FILL,
            "inline-flex items-center justify-end pr-0.5 text-[8px] font-semibold text-emerald-700/55 ring-emerald-300 dark:text-emerald-300/60 dark:ring-emerald-800"
          )}
        >
          N
        </span>
        has stray IPs
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            swatch,
            FREE_FILL,
            "ring-emerald-300 dark:ring-emerald-800"
          )}
        >
          <span className={cn(RANGE_STRIP, "left-1 w-2.5")} />
        </span>
        has IP ranges
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, FREE_FILL)}>
          <span className="absolute inset-y-0 left-0 w-1.5 bg-background">
            <span className={cn("absolute inset-0", USED_FILL)} />
          </span>
          <span
            className="absolute inset-y-0 left-[11px] w-1"
            style={HATCH_STYLE}
          />
          <span className={PARTIAL_EDGE} />
        </span>
        partly used
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(swatch, USED_FILL, "ring-rose-300 dark:ring-rose-800")}
        />
        used
      </span>
    </div>
  )
}
