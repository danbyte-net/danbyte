import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { RBACGroup } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of RBAC groups" - /groups builds here.

export type GroupColumnId = "name" | "description" | "users" | "permissions"

const CANONICAL_ORDER: GroupColumnId[] = [
  "name",
  "description",
  "users",
  "permissions",
]

export interface GroupColumnOpts {
  omit?: GroupColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<RBACGroup>
}

export function buildGroupColumns(
  opts: GroupColumnOpts = {}
): ColumnDef<RBACGroup, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<GroupColumnId, () => ColumnDef<RBACGroup, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/groups/$id/edit"
          params={{ id: String(row.original.id) }}
          className="link flex items-center gap-2 font-medium"
        >
          {row.original.name}
          {row.original.built_in && (
            <Badge variant="secondary" className="text-[10px]">
              built-in
            </Badge>
          )}
        </Link>
      ),
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
    users: () => ({
      id: "users",
      accessorKey: "user_count",
      header: ({ column }) => <SortHeader column={column} label="Users" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.user_count}</span>
      ),
    }),
    permissions: () => ({
      id: "permissions",
      accessorKey: "permission_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Permissions" />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.permission_count}</span>
      ),
    }),
  }

  const cols: ColumnDef<RBACGroup, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<RBACGroup>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<RBACGroup>(opts.actions))
  return cols
}
