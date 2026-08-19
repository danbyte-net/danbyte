import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ComplianceViolation, Site } from "@/lib/api"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { dash } from "@/components/cells/dash"
import { countCell } from "@/components/cells/count-cell"
import type { ZeroCounts } from "@/components/cells/count-cell"
import { numidColumn } from "@/components/cells/numid"
import { VrfCell } from "@/components/cells/vrf-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of sites". Every surface that lists
// sites - /sites, the compliance affected-objects table - builds its columns
// here so a site row reads identically everywhere. Page-specific columns are
// spliced around this factory's output; the shared cells are never re-authored
// inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

const POLICY_LABEL: Record<Site["gateway_policy"], string> = {
  first: "First IP",
  last: "Last IP",
  none: "None",
}

export type SiteColumnId =
  | "numid"
  | "name"
  | "location"
  | "gateway_policy"
  | "prefixes"
  | "vlans"
  | "vrfs"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: SiteColumnId[] = [
  "numid",
  "name",
  "location",
  "gateway_policy",
  "prefixes",
  "vlans",
  "vrfs",
  "description",
  "tags",
  "updated",
]

export interface SiteColumnOpts<T extends Site = Site> {
  /** Drop columns. */
  omit?: SiteColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: SiteColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Columns whose header stays plain text instead of a sortable SortHeader -
   * the read-only tables never offered sorting on them. */
  plainHeaders?: SiteColumnId[]
  /** Count columns render `-` for zero (the list page) or print the 0
   * (read-only tables). */
  zeroCounts?: ZeroCounts
  /** Compliance violation badge next to the name. Pass a pre-resolved map to
   * avoid one lookup hook per row; `true` lets each badge subscribe itself. */
  violations?: boolean | Map<string, ComplianceViolation[]>
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildSiteColumns<T extends Site = Site>(
  opts: SiteColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: SiteColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const plain = new Set(opts.plainHeaders ?? [])
  const head = (
    id: SiteColumnId,
    label: string
  ): ColumnDef<T, unknown>["header"] =>
    plain.has(id)
      ? label
      : ({ column }) => <SortHeader column={column} label={label} />

  const count = (n: number) => countCell(n, opts.zeroCounts)

  const byId: Record<SiteColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: head("name", "Site"),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/sites/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          {opts.violations && (
            <ViolationBadge
              objectId={row.original.id}
              map={opts.violations === true ? undefined : opts.violations}
            />
          )}
          <PlannedChangeMarker
            objectType="api.site"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    location: () => ({
      id: "location",
      accessorKey: "location",
      header: head("location", "Address"),
      cell: ({ row }) =>
        row.original.location ? (
          <span className="text-xs text-muted-foreground">
            {row.original.location}
          </span>
        ) : (
          dash
        ),
    }),
    gateway_policy: () => ({
      id: "gateway_policy",
      accessorKey: "gateway_policy",
      header: head("gateway_policy", "Gateway"),
      cell: ({ row }) => (
        <span className="text-xs">
          {POLICY_LABEL[row.original.gateway_policy]}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Gateway policy",
          get: (r: T) => r.gateway_policy,
          // `v` is a raw facet value off the wire, so a policy this client
          // doesn't know about is possible even though the type says it isn't.
          // Widening the lookup keeps the fallback honest - without it the cast
          // makes the `??` look dead and an unknown policy renders "undefined".
          formatValue: (v) => ({
            label: (POLICY_LABEL as Record<string, string | undefined>)[v] ?? v,
          }),
        },
      },
    }),
    prefixes: () => ({
      id: "prefixes",
      accessorKey: "prefix_count",
      header: head("prefixes", "Prefixes"),
      cell: ({ row }) => count(row.original.prefix_count),
    }),
    vlans: () => ({
      id: "vlans",
      accessorKey: "vlan_count",
      header: head("vlans", "VLANs"),
      cell: ({ row }) => count(row.original.vlan_count),
    }),
    vrfs: () => ({
      id: "vrfs",
      header: "VRFs",
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.vrfs.length === 0) return dash
        return (
          <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
            {row.original.vrfs.map((v) => (
              <VrfCell key={v.id} vrf={v} />
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "tags",
          label: "VRFs",
          get: (r: T) =>
            r.vrfs.map((v) => ({
              slug: v.id,
              name: v.name,
              color: v.color || undefined,
            })),
        },
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
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
