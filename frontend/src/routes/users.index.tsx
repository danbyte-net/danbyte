import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { KeyRound } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type RBACUser, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { RowActions } from "@/components/row-actions"
import { UserDeleteDialog } from "@/components/user-delete-dialog"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

// One-click "email a password-reset link" for a row. Sends the email only —
// the user's current password is untouched; it changes only when they follow
// the link and choose a new one.
function ResetButton({ user }: { user: RBACUser }) {
  const m = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; email: string }>(`/api/users/${user.id}/send-reset/`, {
        method: "POST",
      }),
    onSuccess: (r) => toast.success(`Reset link sent to ${r.email}`),
    onError: (err) => apiErrorToast(err),
  })
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title={
        user.email ? "Email a password-reset link" : "User has no email address"
      }
      disabled={m.isPending || !user.email}
      onClick={() => m.mutate()}
    >
      {m.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <KeyRound className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">Send password-reset link</span>
    </Button>
  )
}

export const Route = createFileRoute("/users/")({ component: UsersPage })

function UsersPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<RBACUser | null>(null)
  const { canDo } = useMe()
  const canAdd = canDo("user", "add")
  const canEdit = canDo("user", "change")
  const canDelete = canDo("user", "delete")

  const query = useQuery({
    queryKey: ["users", q],
    queryFn: () =>
      api<Paginated<RBACUser>>(
        `/api/users/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const handleDelete = useCallback((u: RBACUser) => setDeleting(u), [])
  const columns = useMemo<ColumnDef<RBACUser>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Users"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by username or email…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/users/new">Add user</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="email"
        tableId="users"
      />
      <UserDeleteDialog
        user={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (u: RBACUser) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<RBACUser>[] {
  return [
    {
      id: "username",
      accessorKey: "username",
      header: ({ column }) => <SortHeader column={column} label="Username" />,
      cell: ({ row }) => (
        <Link
          to="/users/$id/edit"
          params={{ id: String(row.original.id) }}
          className="flex items-center gap-2 font-mono text-xs font-medium hover:underline"
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
    },
    {
      id: "name",
      accessorFn: (u) => `${u.first_name} ${u.last_name}`.trim(),
      header: "Name",
      cell: ({ row }) => {
        const name =
          `${row.original.first_name} ${row.original.last_name}`.trim()
        return name ? (
          <span className="text-xs">{name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "email",
      accessorKey: "email",
      header: ({ column }) => <SortHeader column={column} label="Email" />,
      cell: ({ row }) =>
        row.original.email ? (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.email}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "groups",
      accessorFn: (u) => u.groups.map((g) => g.name).join(", "),
      header: "Groups",
      cell: ({ row }) =>
        row.original.groups.length ? (
          <span className="text-xs">
            {row.original.groups.map((g) => g.name).join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
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
    },
    timeAgoColumn<RBACUser>({
      id: "last_login",
      header: "Last login",
      get: (r) => r.last_login,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/users/$id/edit" : undefined}
          editParams={{ id: String(row.original.id) }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
          extra={canEdit ? <ResetButton user={row.original} /> : undefined}
        />
      ),
    },
  ]
}
