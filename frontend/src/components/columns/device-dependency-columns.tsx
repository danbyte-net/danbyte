import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DependencyEnd, DeviceDependency } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import { DependencyMediumBadge } from "@/components/dependency-medium-badge"
import { Badge } from "@/components/ui/badge"

// The one source of truth for "a table of device dependencies" (#450): the
// Dependencies list and the medium's Dependencies tab build here.

export type DeviceDependencyColumnId =
  | "downstream"
  | "upstream"
  | "kind"
  | "medium"
  | "redundancy_group"
  | "site"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: DeviceDependencyColumnId[] = [
  "downstream",
  "upstream",
  "kind",
  "medium",
  "redundancy_group",
  "site",
  "description",
  "tags",
  "updated",
]

export const DEPENDENCY_KIND_LABELS: Record<string, string> = {
  dependency: "Dependency",
  peer: "Peer",
}

export interface DeviceDependencyColumnOpts<
  T extends DeviceDependency = DeviceDependency,
> {
  omit?: DeviceDependencyColumnId[]
  selection?: boolean
  humanIds?: boolean
  actions?: ActionsColumnOpts<T>
}

/** An end's sort and search text; an end the caller may not view reads
 * "Hidden". */
export function dependencyEndText(e: DependencyEnd | null): string {
  return e ? e.name : "Hidden"
}

/** One end linked to its device; a device the caller may not view is a
 * muted "Hidden". */
export function DependencyEndCell({ end }: { end: DependencyEnd | null }) {
  if (!end) return <span className="text-xs text-muted-foreground">Hidden</span>
  return (
    <Link to="/devices/$id" params={{ id: end.id }} className="link">
      {end.name}
    </Link>
  )
}

function siteOf(r: DeviceDependency) {
  return r.downstream?.site ?? r.upstream?.site ?? null
}

export function buildDeviceDependencyColumns<
  T extends DeviceDependency = DeviceDependency,
>(opts: DeviceDependencyColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const byId: Record<DeviceDependencyColumnId, ColumnDef<T, unknown>> = {
    downstream: {
      id: "downstream",
      accessorFn: (r) => dependencyEndText(r.downstream),
      header: ({ column }) => <SortHeader column={column} label="Downstream" />,
      cell: ({ row }) => <DependencyEndCell end={row.original.downstream} />,
    },
    upstream: {
      id: "upstream",
      accessorFn: (r) => dependencyEndText(r.upstream),
      header: ({ column }) => <SortHeader column={column} label="Upstream" />,
      cell: ({ row }) => <DependencyEndCell end={row.original.upstream} />,
    },
    kind: {
      id: "kind",
      accessorKey: "kind",
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ row }) =>
        row.original.kind === "peer" ? (
          <Badge variant="secondary">Peer</Badge>
        ) : (
          <span className="text-xs">Dependency</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: T) => r.kind,
          formatValue: (v) => ({ label: DEPENDENCY_KIND_LABELS[v] ?? v }),
        },
      },
    },
    medium: {
      id: "medium",
      accessorFn: (r) => r.medium?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Medium" />,
      cell: ({ row }) =>
        row.original.medium ? (
          <DependencyMediumBadge medium={row.original.medium} />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Medium",
          get: (r: T) => r.medium?.id ?? "",
          formatValue: (_v, r) => ({ label: r.medium?.name ?? "None" }),
        },
      },
    },
    redundancy_group: {
      id: "redundancy_group",
      accessorKey: "redundancy_group",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) =>
        row.original.redundancy_group ? (
          <span className="font-mono text-xs">
            {row.original.redundancy_group}
          </span>
        ) : (
          dash
        ),
    },
    site: {
      id: "site",
      accessorFn: (r) => siteOf(r)?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => {
        const s = siteOf(row.original)
        return s ? (
          <Link to="/sites/$id" params={{ id: s.id }} className="link">
            {s.name}
          </Link>
        ) : (
          dash
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: T) => siteOf(r)?.id ?? "",
          formatValue: (_v, r) => ({ label: siteOf(r)?.name ?? "None" }),
        },
      },
    },
    description: {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    },
    tags: tagsColumn<T>({ getTags: (r) => r.tags }),
    updated: timeAgoColumn<T>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
  }
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  if (opts.humanIds) cols.push(numidColumn<T>({ get: (r) => r.numid }))
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id])
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
