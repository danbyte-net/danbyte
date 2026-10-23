import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CoolingFeed, CoolingFeedCapacity } from "@/lib/api"
import { hasCoolingData, rackCoolingRatio } from "@/lib/rack-capacity"
import type { RackCooling } from "@/lib/rack-capacity"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { CoolingFigure } from "@/components/cells/power-figure"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { numidColumn } from "@/components/cells/numid"
import { rackColumn } from "@/components/cells/rack-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import {
  fmtRating,
  loadText,
} from "@/components/columns/cooling-source-columns"

// The one source of truth for "a table of cooling feeds" (#434). The
// /cooling-feeds list, a source's Feeds tab and a rack's Cooling feeds tab
// all build their columns here, so a feed row reads the same in each.

/** A feed's load in the shape the cooling figure reads: its rack's heat over
 * what the feed delivers. */
export function feedCooling(c: CoolingFeedCapacity): RackCooling {
  return {
    available_w: c.available_w,
    heat_allocated_w: c.heat_allocated_w,
    heat_maximum_w: c.heat_maximum_w,
    supply: null,
    mismatched: 0,
  }
}

/** A decimal the API sends as a string, with its unit: "18.5 °C"; a dash
 * when not recorded. */
export function fmtDecimal(v: string | null | undefined, unit: string): string {
  if (v == null || v === "") return "-"
  const n = Number(v)
  return Number.isFinite(n) ? `${n} ${unit}` : "-"
}

export type CoolingFeedColumnId =
  | "numid"
  | "name"
  | "source"
  | "site"
  | "rack"
  | "status"
  | "type"
  | "rated"
  | "max"
  | "flow"
  | "supply"
  | "return"
  | "connector"
  | "load"
  | "tags"

const CANONICAL_ORDER: CoolingFeedColumnId[] = [
  "numid",
  "name",
  "source",
  "site",
  "rack",
  "status",
  "type",
  "rated",
  "max",
  "flow",
  "supply",
  "return",
  "connector",
  "load",
  "tags",
]

export interface CoolingFeedColumnOpts<T extends CoolingFeed = CoolingFeed> {
  /** Drop columns (e.g. a source's own page omits "source"). */
  omit?: CoolingFeedColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CoolingFeedColumnId[]
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

export function buildCoolingFeedColumns<T extends CoolingFeed = CoolingFeed>(
  opts: CoolingFeedColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CoolingFeedColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const decimal = (
    id: "flow" | "supply" | "return",
    header: string,
    unit: string,
    get: (r: T) => string | null
  ): ColumnDef<T, unknown> => ({
    id,
    accessorFn: (r) => {
      const v = get(r)
      return v == null || v === "" ? null : Number(v)
    },
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <span className="num text-xs">{fmtDecimal(get(row.original), unit)}</span>
    ),
    meta: { export: { value: (r: T) => get(r) ?? "" } },
  })

  const byId: Record<CoolingFeedColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/cooling-feeds/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.coolingfeed"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    source: () => ({
      id: "source",
      accessorFn: (f) => f.source.name,
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      // A feed always runs from a source (non-nullable FK).
      cell: ({ row }) => (
        <Link
          to="/cooling-sources/$id"
          params={{ id: row.original.source.id }}
          className="link text-xs"
        >
          {row.original.source.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Source",
          get: (r: T) => r.source.id,
          formatValue: (_v, s) => ({ label: s.source.name }),
        },
      },
    }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    rack: () => rackColumn<T>({ get: (r) => r.rack, className: "text-xs" }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    }),
    type: () => ({
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.type_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.type,
          formatValue: (_v, sample) => ({ label: sample.type_display }),
        },
      },
    }),
    rated: () => ({
      id: "rated",
      accessorFn: (r) => r.rated_capacity_w ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Rated" />,
      cell: ({ row }) => (
        <span className="num text-xs">
          {fmtRating(row.original.rated_capacity_w)}
        </span>
      ),
      meta: {
        export: { value: (r: T) => r.rated_capacity_w ?? "" },
      },
    }),
    max: () => ({
      id: "max",
      accessorKey: "max_utilization",
      header: "Max util.",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.max_utilization}%</span>
      ),
    }),
    flow: () => decimal("flow", "Flow", "L/min", (r) => r.flow_rate_lpm),
    supply: () => decimal("supply", "Supply", "°C", (r) => r.supply_temp_c),
    return: () => decimal("return", "Return", "°C", (r) => r.return_temp_c),
    connector: () => ({
      id: "connector",
      accessorKey: "connector",
      header: "Connector",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.connector || "-"}</span>
      ),
    }),
    load: () => ({
      id: "load",
      accessorFn: (r) => {
        const c = feedCooling(r.capacity)
        return hasCoolingData(c) ? (rackCoolingRatio(c) ?? -1) : -1
      },
      header: ({ column }) => <SortHeader column={column} label="Load" />,
      cell: ({ row }) => (
        <CoolingFigure cooling={feedCooling(row.original.capacity)} bar />
      ),
      meta: {
        export: { value: (r: T) => loadText(feedCooling(r.capacity)) },
      },
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
