import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { PowerFeed } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { numidColumn } from "@/components/cells/numid"
import { rackColumn } from "@/components/cells/rack-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of power feeds". The /power-feeds list
// and the Feeds pane on a power panel's detail page both build their columns
// here, so a feed row reads identically in both places. Facet meta
// (useTableFilters) is attached where it makes sense; panes that don't draw a
// facet rail simply ignore it.

/** "230V / 32A" — the electrical rating, em dash when neither is recorded. */
export function fmtPower(f: PowerFeed): string {
  if (f.voltage == null && f.amperage == null) return "—"
  const v = f.voltage != null ? `${f.voltage}V` : ""
  const a = f.amperage != null ? `${f.amperage}A` : ""
  return [v, a].filter(Boolean).join(" / ")
}

export type PowerFeedColumnId =
  | "numid"
  | "name"
  | "panel"
  | "rack"
  | "status"
  | "type"
  | "supply"
  | "phase"
  | "power"
  | "max"
  | "tags"

const CANONICAL_ORDER: PowerFeedColumnId[] = [
  "numid",
  "name",
  "panel",
  "rack",
  "status",
  "type",
  "supply",
  "phase",
  "power",
  "max",
  "tags",
]

export interface PowerFeedColumnOpts<T extends PowerFeed = PowerFeed> {
  /** Drop columns (e.g. a panel's own page omits "panel"). */
  omit?: PowerFeedColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: PowerFeedColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildPowerFeedColumns<T extends PowerFeed = PowerFeed>(
  opts: PowerFeedColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: PowerFeedColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<PowerFeedColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/power-feeds/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.powerfeed"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    panel: () => ({
      id: "panel",
      accessorFn: (f) => f.power_panel.name,
      header: "Panel",
      // A feed always draws from a panel (non-nullable FK), so this cell never
      // has an empty state.
      cell: ({ row }) => (
        <Link
          to="/power-panels/$id"
          params={{ id: row.original.power_panel.id }}
          className="text-xs hover:underline"
        >
          {row.original.power_panel.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Panel",
          get: (r: T) => r.power_panel.id,
          formatValue: (_v, s) => ({ label: s.power_panel.name }),
        },
      },
    }),
    rack: () => rackColumn<T>({ get: (r) => r.rack, className: "text-xs" }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
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
    supply: () => ({
      id: "supply",
      accessorKey: "supply",
      header: "Supply",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.supply_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Supply",
          get: (r: T) => r.supply,
          formatValue: (_v, sample) => ({ label: sample.supply_display }),
        },
      },
    }),
    phase: () => ({
      id: "phase",
      accessorKey: "phase",
      header: "Phase",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.phase_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Phase",
          get: (r: T) => r.phase,
          formatValue: (_v, sample) => ({ label: sample.phase_display }),
        },
      },
    }),
    power: () => ({
      id: "power",
      header: "Power",
      cell: ({ row }) => (
        <span className="num text-xs">{fmtPower(row.original)}</span>
      ),
    }),
    max: () => ({
      id: "max",
      accessorKey: "max_utilization",
      header: "Max util.",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.max_utilization}%</span>
      ),
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
