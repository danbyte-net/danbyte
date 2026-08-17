import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Cluster } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { SiteCell, siteColumn } from "@/components/cells/site-cell"
import type { SiteVariant } from "@/components/cells/site-cell"
import { countCell } from "@/components/cells/count-cell"
import type { ZeroCounts } from "@/components/cells/count-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of clusters". Every surface that lists
// clusters — /clusters and the embedded cluster pane on a cluster-type /
// cluster-group / site detail page — builds its columns here so a cluster row
// reads identically everywhere. Page-specific columns are spliced around this
// factory's output; the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type ClusterColumnId =
  | "numid"
  | "name"
  | "type"
  | "group"
  | "site"
  | "status"
  | "vms"
  | "tags"
  | "description"
  | "updated"

const CANONICAL_ORDER: ClusterColumnId[] = [
  "numid",
  "name",
  "type",
  "group",
  "site",
  "status",
  "vms",
  "tags",
  "description",
  "updated",
]

export interface ClusterColumnOpts<T extends Cluster = Cluster> {
  /** Drop columns (e.g. the cluster-type page omits "type"). */
  omit?: ClusterColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ClusterColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Cluster-type rendering. "text" (default) is small plain text under a
   * sortable header; "badge" is the neutral chip the embedded pane uses. */
  typeVariant?: "text" | "badge"
  /** Site rendering — see {@link SiteVariant}. Defaults to "link". */
  siteVariant?: SiteVariant
  /** How a zero VM count renders — see {@link ZeroCounts}. The embedded pane
   * counts members, so there "0" is the answer rather than "unknown". */
  zeroCounts?: ZeroCounts
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildClusterColumns<T extends Cluster = Cluster>(
  opts: ClusterColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ClusterColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ClusterColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/clusters/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.cluster"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    type: () =>
      opts.typeVariant === "badge"
        ? {
            id: "type",
            accessorFn: (r) => r.type.name,
            header: "Type",
            cell: ({ row }) => (
              <Link
                to="/cluster-types/$id"
                params={{ id: row.original.type.id }}
                className="hover:underline"
              >
                <ColorBadge name={row.original.type.name} color={undefined} />
              </Link>
            ),
          }
        : {
            id: "type",
            header: ({ column }) => <SortHeader column={column} label="Type" />,
            accessorFn: (r) => r.type.name,
            cell: ({ row }) => (
              <Link
                to="/cluster-types/$id"
                params={{ id: row.original.type.id }}
                className="link text-xs"
              >
                {row.original.type.name}
              </Link>
            ),
            meta: {
              facet: {
                kind: "enum",
                label: "Type",
                get: (r: T) => r.type.name,
              },
            },
          },
    group: () => ({
      id: "group",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      accessorFn: (r) => r.group?.name ?? "",
      cell: ({ row }) =>
        row.original.group ? (
          <span className="text-xs">{row.original.group.name}</span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: T) => r.group?.name ?? "—",
        },
      },
    }),
    site: () =>
      opts.siteVariant === "plain"
        ? {
            id: "site",
            accessorFn: (r) => r.site?.name ?? "",
            header: "Site",
            cell: ({ row }) => (
              <SiteCell
                site={row.original.site}
                linked={false}
                className="text-xs text-muted-foreground"
              />
            ),
          }
        : siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
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
    vms: () => ({
      id: "vms",
      accessorKey: "vm_count",
      header: ({ column }) => <SortHeader column={column} label="VMs" />,
      cell: ({ row }) => countCell(row.original.vm_count, opts.zeroCounts),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
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
