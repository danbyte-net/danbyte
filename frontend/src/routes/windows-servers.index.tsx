import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type WindowsConnection } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { buildWindowsServerColumns } from "@/components/columns/windows-server-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { WindowsConnectionDialog } from "@/components/integrations/windows-connection-dialog"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/windows-servers/")({
  component: WindowsServersPage,
})

function WindowsServersPage() {
  const { canDo } = useMe()
  const canAdd = canDo("windowsserverconnection", "add")
  const canEdit = canDo("windowsserverconnection", "change")
  const canDelete = canDo("windowsserverconnection", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WindowsConnection | null>(null)
  const [deleting, setDeleting] = useState<WindowsConnection | null>(null)
  const [selected, setSelected] = useState<WindowsConnection[]>([])
  const selectable = canEdit || canDelete

  const query = useQuery({
    queryKey: ["windows-connections", q],
    queryFn: () =>
      apiAll<WindowsConnection>(
        `/api/windows-connections/?${new URLSearchParams({ search: q })}`
      ),
  })
  const rows = query.data?.results ?? []

  const del = useMutation({
    mutationFn: (c: WindowsConnection) =>
      api(`/api/windows-connections/${c.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Server removed")
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["windows-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo(
    () =>
      buildWindowsServerColumns<WindowsConnection>({
        selection: selectable,
        actions: {
          onEdit: canEdit ? setEditing : undefined,
          onDelete: canDelete ? setDeleting : undefined,
        },
      }),
    [canEdit, canDelete, selectable]
  )

  return (
    <ListPageShell
      title="Windows servers"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter servers…" }}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add server
          </Button>
        )
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No Windows servers connected.">
          Connect a Windows Server over WinRM to sync its DHCP scopes and
          reservations - and DNS zones - into Danbyte. The server needs nothing
          installed; Danbyte talks to the built-in PowerShell modules.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          total={query.data?.count}
          columns={columns}
          flexColumn="host"
          tableId="windows-servers"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/windows-connections/"
        noun={["server", "servers"]}
        invalidate={[["windows-connections"], ["dhcp-scopes"], ["dns-zones"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="windowsserverconnection"
      />
      {creating && <WindowsConnectionDialog onOpenChange={setCreating} />}
      {editing && (
        <WindowsConnectionDialog
          connection={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the connection and its DHCP/DNS links. Prefixes, IP
              addresses and records it created stay in IPAM - they simply stop
              syncing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleting) del.mutate(deleting)
              }}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ListPageShell>
  )
}
