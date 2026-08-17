import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Tunnel } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of tunnels". The /tunnels list, the
// Tunnels pane on a tunnel group, and the Tunnels pane on an IPSec profile all
// build their columns here, so a tunnel row reads identically in all three.
// A group page omits "group" and a profile page omits "profile" — the column
// that repeats the object you are already looking at. Facet meta
// (useTableFilters) is attached where it makes sense; panes that don't draw a
// facet rail simply ignore it.

export type TunnelColumnId =
  | "numid"
  | "name"
  | "status"
  | "encapsulation"
  | "group"
  | "profile"
  | "tunnel_id"
  | "description"
  | "tags"

const CANONICAL_ORDER: TunnelColumnId[] = [
  "numid",
  "name",
  "status",
  "encapsulation",
  "group",
  "profile",
  "tunnel_id",
  "description",
  "tags",
]

export interface TunnelColumnOpts<T extends Tunnel = Tunnel> {
  /** Drop columns (e.g. a group's own page omits "group"). */
  omit?: TunnelColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: TunnelColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildTunnelColumns<T extends Tunnel = Tunnel>(
  opts: TunnelColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: TunnelColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<TunnelColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/tunnels/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.tunnel"
            objectId={row.original.id}
          />
        </span>
      ),
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
    encapsulation: () => ({
      id: "encapsulation",
      accessorKey: "encapsulation",
      header: "Encapsulation",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.encapsulation_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Encapsulation",
          get: (r: T) => r.encapsulation,
          formatValue: (_v, sample) => ({
            label: sample.encapsulation_display,
          }),
        },
      },
    }),
    group: () => ({
      id: "group",
      accessorFn: (t) => t.group?.name ?? "",
      header: "Group",
      cell: ({ row }) =>
        row.original.group ? (
          <Link
            to="/tunnel-groups/$id"
            params={{ id: row.original.group.id }}
            className="link text-xs"
          >
            {row.original.group.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: T) => r.group?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.group?.name ?? "No group",
          }),
        },
      },
    }),
    profile: () => ({
      id: "profile",
      accessorFn: (t) => t.ipsec_profile?.name ?? "",
      header: "IPSec profile",
      cell: ({ row }) =>
        row.original.ipsec_profile ? (
          <Link
            to="/ipsec-profiles/$id"
            params={{ id: row.original.ipsec_profile.id }}
            className="link text-xs"
          >
            {row.original.ipsec_profile.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "IPSec profile",
          get: (r: T) => r.ipsec_profile?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.ipsec_profile?.name ?? "No profile",
          }),
        },
      },
    }),
    tunnel_id: () => ({
      id: "tunnel_id",
      accessorKey: "tunnel_id",
      header: ({ column }) => <SortHeader column={column} label="ID" />,
      cell: ({ row }) =>
        row.original.tunnel_id != null ? (
          <span className="num font-mono text-xs">
            {row.original.tunnel_id}
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
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
