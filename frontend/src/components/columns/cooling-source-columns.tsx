import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CoolingSource, CoolingSourceCapacity } from "@/lib/api"
import {
  formatWatts,
  hasCoolingData,
  rackCoolingDemand,
  rackCoolingRatio,
} from "@/lib/rack-capacity"
import type { RackCooling } from "@/lib/rack-capacity"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { CoolingFigure } from "@/components/cells/power-figure"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { numidColumn } from "@/components/cells/numid"
import { siteColumn } from "@/components/cells/site-cell"
import { locationColumn } from "@/components/cells/location-cell"
import { deviceColumn } from "@/components/cells/device-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of cooling sources" (#434), read the
// way the power panels' table is. Facet meta is attached where it makes
// sense; panes that don't draw a facet rail ignore it.

/** A source's load in the shape the cooling figure reads: the heat of the
 * racks its feeds reach over its rating. */
export function sourceCooling(c: CoolingSourceCapacity): RackCooling {
  return {
    available_w: c.available_w,
    heat_allocated_w: c.heat_allocated_w,
    heat_maximum_w: c.heat_maximum_w,
    supply: null,
    mismatched: 0,
  }
}

/** The load figure as export text: "3.2 kW / 10 kW", "" with nothing. */
export function loadText(c: RackCooling): string {
  if (!hasCoolingData(c)) return ""
  const heat = formatWatts(rackCoolingDemand(c).watts)
  return c.available_w > 0 ? `${heat} / ${formatWatts(c.available_w)}` : heat
}

/** "12 kW" - a rating in watts, a dash when not recorded. */
export function fmtRating(watts: number | null | undefined): string {
  return watts ? formatWatts(watts) : "-"
}

export type CoolingSourceColumnId =
  | "numid"
  | "name"
  | "site"
  | "location"
  | "type"
  | "status"
  | "fluid"
  | "rated"
  | "feeds"
  | "load"
  | "group"
  | "device"
  | "tags"

const CANONICAL_ORDER: CoolingSourceColumnId[] = [
  "numid",
  "name",
  "site",
  "location",
  "type",
  "status",
  "fluid",
  "rated",
  "feeds",
  "load",
  "group",
  "device",
  "tags",
]

export interface CoolingSourceColumnOpts<
  T extends CoolingSource = CoolingSource,
> {
  omit?: CoolingSourceColumnId[]
  include?: CoolingSourceColumnId[]
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

export function buildCoolingSourceColumns<
  T extends CoolingSource = CoolingSource,
>(opts: CoolingSourceColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CoolingSourceColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CoolingSourceColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/cooling-sources/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.coolingsource"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    location: () =>
      locationColumn<T>({ get: (r) => r.location, className: "text-xs" }),
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
    fluid: () => ({
      id: "fluid",
      accessorKey: "fluid",
      header: "Fluid",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.fluid_display || "-"}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Fluid",
          get: (r: T) => r.fluid || "__none__",
          formatValue: (_v, sample) => ({
            label: sample.fluid_display || "Not recorded",
          }),
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
    feeds: () => ({
      id: "feeds",
      accessorKey: "feed_count",
      header: ({ column }) => <SortHeader column={column} label="Feeds" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.feed_count}</span>
      ),
    }),
    load: () => ({
      id: "load",
      accessorFn: (r) => {
        const c = sourceCooling(r.capacity)
        return hasCoolingData(c) ? (rackCoolingRatio(c) ?? -1) : -1
      },
      header: ({ column }) => <SortHeader column={column} label="Load" />,
      cell: ({ row }) => (
        <CoolingFigure cooling={sourceCooling(row.original.capacity)} bar />
      ),
      meta: {
        export: { value: (r: T) => loadText(sourceCooling(r.capacity)) },
      },
    }),
    group: () => ({
      id: "group",
      accessorKey: "redundancy_group",
      header: "Redundancy group",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.redundancy_group || "-"}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Redundancy group",
          get: (r: T) => r.redundancy_group || "__none__",
          formatValue: (_v, sample) => ({
            label: sample.redundancy_group || "None",
          }),
        },
      },
    }),
    device: () =>
      deviceColumn<T>({ get: (r) => r.device, className: "text-xs" }),
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
