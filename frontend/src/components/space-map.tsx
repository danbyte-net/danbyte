import { useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, CornerDownRight } from "lucide-react"

import {
  api,
  type SpaceMap as SpaceMapData,
  type SpaceMapCell,
} from "@/lib/api"
import { parseCidr } from "@/lib/prefix-tree"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface SpaceMapProps {
  /** Parent prefix UUID — the map is fetched + IP/child create attach to it. */
  prefixId: string
  /** VRF UUID for the parent prefix — pre-fills the create page when the
   * user clicks a free cell. NULL = Global VRF. */
  vrfId?: string | null
  /** The prefix's own CIDR — the breadcrumb root. */
  rootCidr: string
}

// Visual subnet map for a prefix (IPv4 or IPv6). Each aligned subnet inside the
// prefix gets a cell:
//
//   used  → rose — already covered by a child prefix; click opens that
//                  prefix's detail page.
//   free  → emerald — allocatable; click navigates to /prefixes/new with
//                     this CIDR pre-filled, or "zoom in" to map deeper.
//   dirty → emerald with an amber pill — free, but stray IPs already
//                                        live inside the range.
//
// `within` is a descend stack: clicking "zoom in" on a free cell re-roots the
// map at that cell (an IPv6 /48 has too many levels to show at once, so you
// descend nibble by nibble).
export function SpaceMap({ prefixId, vrfId = null, rootCidr }: SpaceMapProps) {
  const nav = useNavigate()
  const { values } = useUserPrefs()
  const v4Max = Number(values.space_map_v4_max ?? 31)
  const v6Max = Number(values.space_map_v6_max ?? 128)
  const [within, setWithin] = useState<string[]>([])
  const current = within.at(-1)

  const space = useQuery({
    queryKey: ["prefix-space-map", prefixId, current ?? "", v4Max, v6Max],
    queryFn: () => {
      const p = new URLSearchParams({
        v4_max: String(v4Max),
        v6_max: String(v6Max),
      })
      if (current) p.set("within", current)
      return api<SpaceMapData>(
        `/api/prefixes/${prefixId}/space-map/?${p.toString()}`
      )
    },
  })
  const data = space.data

  const crumbs = (
    <Breadcrumbs
      root={rootCidr}
      within={within}
      onJump={(i) => setWithin(within.slice(0, i))}
    />
  )

  if (space.isLoading)
    return <p className="text-sm text-muted-foreground">Loading map…</p>
  if (space.isError)
    return (
      <p className="text-sm text-destructive">
        Failed to load map: {(space.error as Error).message}
      </p>
    )
  if (!data) return null

  if (!data.supported) {
    return (
      <div className="flex flex-col gap-4">
        {within.length > 0 && crumbs}
        <Card className="border-dashed">
          <div className="p-10 text-center text-sm text-muted-foreground">
            Nothing to subdivide here — a map needs a prefix with room (IPv4 /30
            or shorter, IPv6 /127 or shorter).
          </div>
        </Card>
      </div>
    )
  }

  if (data.rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {within.length > 0 && crumbs}
        <Card className="border-dashed">
          <div className="p-10 text-center text-sm text-muted-foreground">
            No aligned subnets to show.
          </div>
        </Card>
      </div>
    )
  }

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
    const address = firstHost(cidr)
    nav({
      to: "/ips/new",
      search: { address, prefix: prefixId },
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Legend />
        {within.length > 0 && crumbs}
      </div>
      {data.rows.map((row) => (
        <section key={row.prefixlen}>
          <h3 className="mb-2 text-xs font-medium">
            <span className="num">
              {row.free_count}/{row.count}
            </span>{" "}
            free <span className="font-mono">/{row.prefixlen}</span> subnets
            {row.dirty_count > 0 && (
              <span className="ml-2 font-normal text-muted-foreground">
                · {row.dirty_count} contain{row.dirty_count === 1 ? "s" : ""}{" "}
                stray IP
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
                allowIp={!!prefixId}
                canDescend={isDescendable(cell.cidr)}
                onCreatePrefix={() => gotoCreatePrefix(cell.cidr)}
                onCreateIp={() => gotoCreateIp(cell.cidr)}
                onDescend={() => setWithin([...within, cell.cidr])}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// A cell can be descended into (mapped deeper) only if it has room to
// subdivide — v4 above /31, v6 above /127.
function isDescendable(cidr: string): boolean {
  const c = parseCidr(cidr)
  if (!c) return false
  return c.prefixlen < (c.family === 4 ? 31 : 128)
}

function Breadcrumbs({
  root,
  within,
  onJump,
}: {
  root: string
  within: string[]
  onJump: (depth: number) => void
}) {
  const trail = [root, ...within]
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {trail.map((cidr, i) => (
        <span key={i} className="contents">
          {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
          {i === trail.length - 1 ? (
            <span className="font-mono font-medium text-foreground">
              {cidr}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onJump(i)}
              className="font-mono hover:text-foreground hover:underline"
            >
              {cidr}
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

// Best-effort first-host extraction for a CIDR string. Splits on "/" and
// returns the network address — the IP form will validate.
function firstHost(cidr: string): string {
  const slash = cidr.indexOf("/")
  return slash > 0 ? cidr.slice(0, slash) : cidr
}

function Cell({
  cell,
  allowIp,
  canDescend,
  onCreatePrefix,
  onCreateIp,
  onDescend,
}: {
  cell: SpaceMapCell
  allowIp: boolean
  canDescend: boolean
  onCreatePrefix: () => void
  onCreateIp: () => void
  onDescend: () => void
}) {
  if (cell.used) {
    const title = `${cell.cidr} — used by ${cell.overlap_with.join(", ")}`
    const cls =
      "block rounded-md bg-rose-100 px-2 py-1.5 text-center font-mono text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200 transition hover:bg-rose-200 hover:ring-rose-400 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900 dark:hover:bg-rose-900/50 dark:hover:ring-rose-700"
    if (cell.prefix_id) {
      return (
        <Link
          to="/prefixes/$id"
          params={{ id: cell.prefix_id }}
          title={title}
          className={cls}
        >
          {cell.cidr}
        </Link>
      )
    }
    return (
      <span title={title} className={cls + " cursor-not-allowed"}>
        {cell.cidr}
      </span>
    )
  }

  const baseCls =
    "relative cursor-pointer rounded-md bg-emerald-100 px-2 py-1.5 text-center font-mono text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 transition hover:bg-emerald-200 hover:ring-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900 dark:hover:bg-emerald-900/50 dark:hover:ring-emerald-700"
  const title = cell.dirty
    ? `${cell.cidr} — free, but ${cell.ip_count} IP${cell.ip_count === 1 ? "" : "s"} inside will be re-parented on save.`
    : `${cell.cidr} — free`

  const body = (
    <>
      {cell.cidr}
      {cell.dirty && (
        <span className="num absolute top-[2px] right-[3px] inline-flex h-[10px] min-w-[10px] items-center justify-center rounded-full px-[2px] text-[8px] leading-none font-semibold text-emerald-700/55 dark:text-emerald-300/60">
          {cell.ip_count}
        </span>
      )}
    </>
  )

  // With no actions and no room to descend, it's a plain "create prefix" button.
  if (!allowIp && !canDescend) {
    return (
      <button
        type="button"
        title={title}
        className={baseCls}
        onClick={onCreatePrefix}
      >
        {body}
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={title} className={baseCls}>
          {body}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {canDescend && (
          <DropdownMenuItem onSelect={onDescend}>
            <CornerDownRight className="h-3.5 w-3.5" /> Zoom into {cell.cidr}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onCreatePrefix}>
          New child prefix here
        </DropdownMenuItem>
        {allowIp && (
          <DropdownMenuItem onSelect={onCreateIp}>
            Register an IP here
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
        <span className="h-3 w-5 rounded-sm bg-rose-100 ring-1 ring-rose-300 ring-inset dark:bg-rose-950/60 dark:ring-rose-800" />
        used
      </span>
    </div>
  )
}
