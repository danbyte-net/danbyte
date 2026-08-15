import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Circuit } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of circuits". The /circuits list and the
// embedded Circuits pane on a site / provider / provider-network detail page all
// build their columns here so a circuit row reads identically everywhere. Facet
// meta (useTableFilters) is attached where it makes sense; panes that don't draw
// a facet rail simply ignore it.

export type CircuitColumnId =
  | "numid"
  | "cid"
  | "provider"
  | "type"
  | "status"
  | "endpoints"
  | "commit"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: CircuitColumnId[] = [
  "numid",
  "cid",
  "provider",
  "type",
  "status",
  "endpoints",
  "commit",
  "description",
  "tags",
  "updated",
]

export interface CircuitColumnOpts<T extends Circuit = Circuit> {
  /** Drop columns (e.g. the provider page omits its own "provider"). */
  omit?: CircuitColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CircuitColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCircuitColumns<T extends Circuit = Circuit>(
  opts: CircuitColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CircuitColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CircuitColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    cid: () => ({
      id: "cid",
      accessorKey: "cid",
      header: ({ column }) => <SortHeader column={column} label="Circuit ID" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/circuits/$id"
            params={{ id: row.original.id }}
            className="font-mono text-xs font-medium hover:underline"
          >
            {row.original.cid}
          </Link>
          <PlannedChangeMarker
            objectType="api.circuit"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    provider: () => ({
      id: "provider",
      accessorFn: (c) => c.provider?.name ?? "",
      header: "Provider",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.provider?.name ?? "—"}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Provider",
          get: (r: T) => r.provider?.id ?? "__none__",
          formatValue: (_v, s) => ({ label: s.provider?.name ?? "None" }),
        },
      },
    }),
    type: () => ({
      id: "type",
      accessorFn: (c) => c.type?.name ?? "",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <ColorBadge
            name={row.original.type.name}
            color={row.original.type.color || undefined}
          />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.type?.id ?? "__none__",
          formatValue: (_v, s) => ({
            label: s.type?.name ?? "None",
            color: s.type?.color,
          }),
        },
      },
    }),
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
    endpoints: () => ({
      id: "endpoints",
      header: "A → Z",
      cell: ({ row }) => {
        const ends = new Map(
          row.original.terminations.map((t) => [
            t.term_side,
            t.site?.name ?? t.provider_network?.name,
          ])
        )
        const a = ends.get("A")
        const z = ends.get("Z")
        if (!a && !z) return dash
        return (
          <span className="text-xs">
            {a ?? "—"} <span className="text-muted-foreground">→</span>{" "}
            {z ?? "—"}
          </span>
        )
      },
    }),
    commit: () => ({
      id: "commit",
      accessorKey: "commit_rate_kbps",
      header: ({ column }) => <SortHeader column={column} label="Commit" />,
      cell: ({ row }) =>
        row.original.commit_rate_kbps != null ? (
          <span className="num text-xs">
            {(row.original.commit_rate_kbps / 1000).toLocaleString()} Mbps
          </span>
        ) : (
          dash
        ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
