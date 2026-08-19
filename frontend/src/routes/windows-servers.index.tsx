import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type WindowsConnection } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SyncStatusBadge as ConnSyncStatusBadge } from "@/components/integrations/sync-status-badge"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
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
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { TimeCell } from "@/components/cells/time-ago"
import { WindowsConnectionDialog } from "@/components/integrations/windows-connection-dialog"

export const Route = createFileRoute("/windows-servers/")({
  component: WindowsServersPage,
})

export function SyncStatusBadge({
  conn,
}: {
  conn: Pick<
    WindowsConnection,
    "last_sync_status" | "last_sync_error" | "last_sync_skipped"
  >
}) {
  return (
    <ConnSyncStatusBadge
      status={conn.last_sync_status}
      error={conn.last_sync_error}
      skipped={conn.last_sync_skipped}
    />
  )
}

export function roleBadges(conn: WindowsConnection) {
  return (
    <span className="flex gap-1">
      {conn.dhcp_enabled && (
        <Badge variant="outline" className="text-[10px]">
          DHCP
        </Badge>
      )}
      {conn.dns_enabled && (
        <Badge variant="outline" className="text-[10px]">
          DNS
        </Badge>
      )}
    </span>
  )
}

function WindowsServersPage() {
  const { canDo } = useMe()
  const canAdd = canDo("windowsserverconnection", "add")
  const canEdit = canDo("windowsserverconnection", "change")
  const canDelete = canDo("windowsserverconnection", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WindowsConnection | null>(null)
  const [deleting, setDeleting] = useState<WindowsConnection | null>(null)

  const query = useQuery({
    queryKey: ["windows-connections", q],
    queryFn: () =>
      api<Paginated<WindowsConnection>>(
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

  const columns = useMemo<ColumnDef<WindowsConnection>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/windows-servers/$id"
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
      },
      {
        id: "host",
        accessorKey: "host",
        header: "Host",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.host}:{row.original.port}
          </span>
        ),
      },
      {
        id: "roles",
        header: "Syncs",
        enableSorting: false,
        cell: ({ row }) => roleBadges(row.original),
      },
      {
        id: "status",
        header: "Last sync",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <SyncStatusBadge conn={row.original} />
            {row.original.last_sync_at && (
              <TimeCell iso={row.original.last_sync_at} />
            )}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => setDeleting(row.original) : undefined}
          />
        ),
      },
    ],
    [canEdit, canDelete, del]
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
          columns={columns}
          flexColumn="host"
          tableId="windows-servers"
        />
      )}
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
              Removes the connection and its DHCP/DNS links. Prefixes, IP addresses and
              records it created stay in IPAM - they simply stop syncing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
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
