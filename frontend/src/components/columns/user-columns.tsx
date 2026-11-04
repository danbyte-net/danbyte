import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { RBACUser } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of user accounts" - /users builds
// here.

export type UserColumnId =
  "username" | "name" | "email" | "groups" | "auth" | "last_login"

const CANONICAL_ORDER: UserColumnId[] = [
  "username",
  "name",
  "email",
  "groups",
  "auth",
  "last_login",
]

export interface UserColumnOpts {
  omit?: UserColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<RBACUser>
}

const fullName = (u: RBACUser) => `${u.first_name} ${u.last_name}`.trim()

export function buildUserColumns(
  opts: UserColumnOpts = {}
): ColumnDef<RBACUser, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<UserColumnId, () => ColumnDef<RBACUser, unknown>> = {
    username: () => ({
      id: "username",
      accessorKey: "username",
      header: ({ column }) => <SortHeader column={column} label="Username" />,
      cell: ({ row }) => (
        <Link
          to="/users/$id/edit"
          params={{ id: String(row.original.id) }}
          className="link flex items-center gap-2 font-mono text-xs font-medium"
        >
          {row.original.username}
          {row.original.is_superuser && (
            <Badge variant="warning" className="text-[10px]">
              superuser
            </Badge>
          )}
          {!row.original.is_active && (
            <Badge variant="secondary" className="text-[10px]">
              inactive
            </Badge>
          )}
        </Link>
      ),
    }),
    name: () => ({
      id: "name",
      accessorFn: fullName,
      header: "Name",
      cell: ({ row }) => {
        const name = fullName(row.original)
        return name ? (
          <span className="text-xs">{name}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
    }),
    email: () => ({
      id: "email",
      accessorKey: "email",
      header: ({ column }) => <SortHeader column={column} label="Email" />,
      cell: ({ row }) =>
        row.original.email ? (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.email}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    groups: () => ({
      id: "groups",
      accessorFn: (u) => u.groups.map((g) => g.name).join(", "),
      header: "Groups",
      cell: ({ row }) =>
        row.original.groups.length ? (
          <span className="text-xs">
            {row.original.groups.map((g) => g.name).join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    auth: () => ({
      id: "auth",
      accessorKey: "auth_source",
      header: "Auth",
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5 text-xs">
          <span className="uppercase">{row.original.auth_source}</span>
          {row.original.require_mfa && (
            <Badge variant="secondary" className="text-[10px]">
              MFA
            </Badge>
          )}
        </span>
      ),
    }),
    last_login: () =>
      timeAgoColumn<RBACUser>({
        id: "last_login",
        header: "Last login",
        get: (r) => r.last_login,
        align: "right",
      }),
  }

  const cols: ColumnDef<RBACUser, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<RBACUser>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<RBACUser>(opts.actions))
  return cols
}
