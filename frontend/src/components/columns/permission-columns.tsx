import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ObjectPermission } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of object permissions (grants)" -
// /permissions builds here.

export type PermissionColumnId =
  | "name"
  | "actions_granted"
  | "object_types"
  | "scope"
  | "assigned"
  | "constraints"

const CANONICAL_ORDER: PermissionColumnId[] = [
  "name",
  "actions_granted",
  "object_types",
  "scope",
  "assigned",
  "constraints",
]

export interface PermissionColumnOpts {
  omit?: PermissionColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<ObjectPermission>
}

export function buildPermissionColumns(
  opts: PermissionColumnOpts = {}
): ColumnDef<ObjectPermission, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<
    PermissionColumnId,
    () => ColumnDef<ObjectPermission, unknown>
  > = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/permissions/$id/edit"
          params={{ id: row.original.id }}
          className="link flex items-center gap-2 font-medium"
        >
          {row.original.name}
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </Link>
      ),
    }),
    actions_granted: () => ({
      id: "actions_granted",
      accessorFn: (p) => p.actions.join(", "),
      header: "Actions",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.actions.join(" · ") || "-"}
        </span>
      ),
    }),
    object_types: () => ({
      id: "object_types",
      accessorFn: (p) => p.object_types.join(", "),
      header: "Object types",
      cell: ({ row }) => {
        const ts = row.original.object_types
        // "*" leaves out users, groups and permissions; name any added back.
        const label = ts.includes("*")
          ? ["All object types", ...ts.filter((t) => t !== "*")].join(" + ")
          : ts.join(", ") || "-"
        return (
          <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
            {label}
          </span>
        )
      },
    }),
    scope: () => ({
      id: "scope",
      accessorFn: (p) => p.tenants.map((t) => t.name).join(", "),
      header: "Tenant scope",
      cell: ({ row }) =>
        row.original.tenants.length ? (
          <span className="text-xs">
            {row.original.tenants.map((t) => t.name).join(", ")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">All</span>
        ),
    }),
    assigned: () => ({
      id: "assigned",
      header: "Assigned to",
      cell: ({ row }) => {
        const g = row.original.groups.length
        const u = row.original.users.length
        const parts: string[] = []
        if (g) parts.push(`${g} group${g > 1 ? "s" : ""}`)
        if (u) parts.push(`${u} user${u > 1 ? "s" : ""}`)
        return (
          <span className="text-xs text-muted-foreground">
            {parts.join(" · ") || "-"}
          </span>
        )
      },
    }),
    constraints: () => ({
      id: "constraints",
      header: "Constraints",
      cell: ({ row }) =>
        row.original.constraints != null ? (
          <Badge variant="secondary" className="text-[10px]">
            scoped
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    }),
  }

  const cols: ColumnDef<ObjectPermission, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<ObjectPermission>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<ObjectPermission>(opts.actions))
  return cols
}
