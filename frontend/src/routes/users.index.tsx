import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { RBACUser } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildUserColumns } from "@/components/columns/user-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { ACTIVATE_WORDS, BulkFlagActions } from "@/components/bulk-flag-actions"
import { UserDeleteDialog } from "@/components/user-delete-dialog"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlSearch } from "@/lib/url-filters"

// One-click "email a password-reset link" for a row. Sends the email only -
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

const ENDPOINT = "/api/users/"
const NOUN: [string, string] = ["user", "users"]

function UsersPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<RBACUser | null>(null)
  const { canDo } = useMe()
  const canAdd = canDo("user", "add")
  const canEdit = canDo("user", "change")
  const canDelete = canDo("user", "delete")

  const query = useQuery({
    queryKey: ["users", q],
    queryFn: () =>
      apiAll<RBACUser>(
        `/api/users/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const selectable = canEdit || canDelete
  const [selected, setSelected] = useState<RBACUser[]>([])
  const clear = () => setSelected([])
  const handleDelete = useCallback((u: RBACUser) => setDeleting(u), [])
  const columns = useMemo(
    () =>
      buildUserColumns({
        selection: selectable,
        actions: {
          editTo: "/users/$id/edit",
          editParams: (u) => ({ id: String(u.id) }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
          extra: (u) => (canEdit ? <ResetButton user={u} /> : null),
        },
      }),
    [handleDelete, canEdit, canDelete, selectable]
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
        total={query.data?.count}
        columns={columns}
        flexColumn="email"
        tableId="users"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      {/* No bulk edit dialog: the one field a bulk change sets is whether
          the account is active. */}
      <SafeBulkEditBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={NOUN}
        invalidate={[["users"]]}
        onCleared={clear}
        canEdit={false}
        canDelete={canDelete}
        actions={
          canEdit && (
            <BulkFlagActions
              endpoint={ENDPOINT}
              field="is_active"
              ids={selected.map((u) => String(u.id))}
              noun={NOUN}
              invalidate={[["users"]]}
              onDone={clear}
              words={ACTIVATE_WORDS}
            />
          )
        }
      />
      <UserDeleteDialog
        user={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
