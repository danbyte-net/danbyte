import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, ChevronRight, Plus, ZoomIn, ZoomOut } from "lucide-react"

import { api } from "@/lib/api"
import type {
  SpaceMap as SpaceMapData,
  SpaceMapCell,
  SpaceMapCellState,
} from "@/lib/api"
import { cellActions, cellNote, zoomStep } from "@/lib/space-map"
import type { SpaceMapAction, SpaceMapStep } from "@/lib/space-map"
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
}

const NO_STEPS: SpaceMapStep[] = []

// Visual subnet map for a prefix (IPv4 or IPv6). Each aligned subnet inside the
// prefix gets a cell, classified by the API:
//
//   free    → emerald - allocatable (a count badge when stray IPs sit in it).
//   partial → emerald with rose bars where smaller child prefixes sit; the
//             block can't be allocated whole, but has room one level down.
//   full    → rose - inside, or exactly, a child prefix.
//
// A cell with one action runs it on click (a partly used cell zooms in); one
// with several opens a menu (lib/space-map.ts holds the rules). The zoom path
// re-roots the map at a cell, which is also how the map goes past the +8-bit
// row cap: a /18 draws down to /26, and zooming carries on from there.
export function SpaceMap({ prefixId, vrfId = null, rootCidr }: SpaceMapProps) {
  const nav = useNavigate()
  const { values } = useUserPrefs()
  const v4Max = Number(values.space_map_v4_max ?? 31)
  const v6Max = Number(values.space_map_v6_max ?? 128)
  // The zoom path, tied to the prefix it was walked on: opening a child from
  // the map re-renders this for another prefix, where the old path is void.
  const [path, setPath] = useState<{ prefixId: string; steps: SpaceMapStep[] }>(
    { prefixId, steps: [] }
  )
  const steps = path.prefixId === prefixId ? path.steps : NO_STEPS
  const current = steps.at(-1)

  // After a zoom the clicked cell is gone; keep keyboard focus in the map.
  const rootRef = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    rootRef.current?.focus()
  }, [path])
  function zoomTo(next: SpaceMapStep[]) {
    refocus.current = true
    setPath({ prefixId, steps: next })
  }

  const space = useQuery({
    queryKey: ["prefix-space-map", prefixId, current?.cidr ?? "", v4Max, v6Max],
    queryFn: () => {
      const p = new URLSearchParams({
        v4_max: String(v4Max),
        v6_max: String(v6Max),
      })
      if (current) p.set("within", current.cidr)
      return api<SpaceMapData>(
        `/api/prefixes/${prefixId}/space-map/?${p.toString()}`
      )
    },
  })
  const data = space.data

  function gotoCreatePrefix(cidr: string) {
    nav({
      to: "/prefixes/new",
      search: {
        cidr,
        vrf: vrfId ?? undefined,
        site: undefined,
        location: undefined,
      },
    })
  }
  function gotoCreateIp(cidr: string) {
    nav({
      to: "/ips/new",
      // The IP's parent is the most specific prefix holding the view.
      search: {
        address: firstHost(cidr),
        prefix: current?.prefix?.id ?? prefixId,
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
        {data.rows.map((row) => (
          <section key={row.prefixlen}>
            <h3 className="mb-2 text-xs font-medium">
              <span className="num">
                {row.free_count}/{row.count}
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
            </h3>
            <div
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${
                  row.count <= 2 ? 2 : row.count <= 4 ? 4 : 8
                }, minmax(0, 1fr))`,
              }}
            >
              {row.cells.map((cell) => (
                <Cell
                  key={cell.cidr}
                  cell={cell}
                  actions={cellActions(cell)}
                  onZoom={() => zoomTo([...steps, zoomStep(cell, current)])}
                  onCreatePrefix={() => gotoCreatePrefix(cell.cidr)}
                  onCreateIp={() => gotoCreateIp(cell.cidr)}
                />
              ))}
            </div>
          </section>
        ))}
      </>
    )

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label={`Space map of ${current?.cidr ?? rootCidr}`}
      className="flex flex-col gap-6 outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Legend />
        {steps.length > 0 && (
          <ZoomTrail
            root={rootCidr}
            steps={steps}
            onJump={(depth) => zoomTo(steps.slice(0, depth))}
          />
        )}
      </div>
      {body}
    </div>
  )
}

// Zoom out one level, or jump to any block on the path. The last crumb is the
// block on screen; when that block is (or sits in) a child prefix, the prefix
// is one click away.
function ZoomTrail({
  root,
  steps,
  onJump,
}: {
  root: string
  steps: SpaceMapStep[]
  onJump: (depth: number) => void
}) {
  const trail = [root, ...steps.map((s) => s.cidr)]
  const here = steps.at(-1)
  const holder = here?.prefix
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() => onJump(steps.length - 1)}
          >
            <ZoomOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>
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
      {holder && holder.cidr !== here.cidr && (
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

const CELL =
  "relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-center font-mono text-[11px] font-medium ring-1 ring-inset transition outline-none focus-visible:ring-2 focus-visible:ring-ring"

const TONE: Record<SpaceMapCellState, string> = {
  free: "cursor-pointer bg-emerald-100 text-emerald-700 ring-emerald-200 hover:bg-emerald-200 hover:ring-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-900/50 dark:hover:ring-emerald-700",
  partial:
    "cursor-pointer bg-emerald-100 text-foreground ring-rose-300 hover:bg-emerald-200 hover:ring-rose-400 dark:bg-emerald-950/40 dark:ring-rose-800 dark:hover:bg-emerald-900/50 dark:hover:ring-rose-600",
  full: "cursor-pointer bg-rose-100 text-rose-700 ring-rose-200 hover:bg-rose-200 hover:ring-rose-400 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900 dark:hover:bg-rose-900/50 dark:hover:ring-rose-700",
}

// The used part of a partly used block: one rose bar per run of child
// prefixes, placed where they sit (a sliver still shows at 3px).
const USED_BAR =
  "pointer-events-none absolute inset-y-0 bg-rose-200 dark:bg-rose-900/40"

function CellFace({ cell }: { cell: SpaceMapCell }) {
  return (
    <>
      {cell.state === "partial" &&
        cell.used_spans.map(([start, end], i) => (
          <span
            key={i}
            aria-hidden
            data-slot="used-span"
            className={USED_BAR}
            style={{
              // Anchor to the nearer edge, so the 3px floor grows inward
              // and a sliver at the end of the block isn't clipped.
              ...(start < 1 - end
                ? { left: `${start * 100}%` }
                : { right: `${(1 - end) * 100}%` }),
              width: `${(end - start) * 100}%`,
              minWidth: 3,
            }}
          />
        ))}
      <span className="relative">{cell.cidr}</span>
      {cell.dirty && (
        <span className="num absolute top-[2px] right-[3px] inline-flex h-[10px] min-w-[10px] items-center justify-center px-[2px] text-[8px] leading-none font-semibold text-emerald-700/55 dark:text-emerald-300/60">
          {cell.ip_count}
        </span>
      )}
    </>
  )
}

function Cell({
  cell,
  actions,
  onZoom,
  onCreatePrefix,
  onCreateIp,
}: {
  cell: SpaceMapCell
  actions: SpaceMapAction[]
  onZoom: () => void
  onCreatePrefix: () => void
  onCreateIp: () => void
}) {
  const note = cellNote(cell)
  const label = `${cell.cidr}, ${note}`
  const cls = cn(CELL, TONE[cell.state])
  const face = <CellFace cell={cell} />
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
          action.kind === "open" ? (
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
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded-sm bg-emerald-100 ring-1 ring-emerald-300 ring-inset dark:bg-emerald-950/60 dark:ring-emerald-800" />
        free
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="relative inline-flex h-3 w-5 items-center justify-end rounded-sm bg-emerald-100 pr-0.5 text-[8px] font-semibold text-emerald-700/55 ring-1 ring-emerald-300 ring-inset dark:bg-emerald-950/60 dark:text-emerald-300/60 dark:ring-emerald-800">
          N
        </span>
        has stray IPs
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="relative h-3 w-5 overflow-hidden rounded-sm bg-emerald-100 ring-1 ring-rose-300 ring-inset dark:bg-emerald-950/60 dark:ring-rose-800">
          <span className="absolute inset-y-0 left-0 w-1.5 bg-rose-200 dark:bg-rose-900/40" />
        </span>
        partly used
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-5 rounded-sm bg-rose-100 ring-1 ring-rose-300 ring-inset dark:bg-rose-950/60 dark:ring-rose-800" />
        used
      </span>
    </div>
  )
}
