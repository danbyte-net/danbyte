import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Inbox, Plug, Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type VirtualizationSource } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormSelect, FormText } from "@/components/forms"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { TimeCell } from "@/components/cells/time-ago"
import { VirtChangesDialog } from "@/components/integrations/virt-changes-dialog"

export const Route = createFileRoute("/virtualization-sources/")({
  component: VirtualizationSourcesPage,
})

function VirtualizationSourcesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("virtualizationsource", "add")
  const canEdit = canDo("virtualizationsource", "change")
  const canDelete = canDo("virtualizationsource", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<VirtualizationSource | null>(null)
  const [reviewing, setReviewing] = useState<VirtualizationSource | null>(null)

  const query = useQuery({
    queryKey: ["virtualization-sources", q],
    queryFn: () =>
      api<Paginated<VirtualizationSource>>(
        `/api/virtualization-sources/?${new URLSearchParams({ search: q })}`
      ),
  })
  const rows = query.data?.results ?? []
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["virtualization-sources"] })

  const del = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api(`/api/virtualization-sources/${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Source removed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const test = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api<{
        ok: boolean
        version?: string
        nodes?: number
        online_nodes?: number
        error?: string
      }>(`/api/virtualization-sources/${s.id}/test/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (r.ok)
        toast.success(
          `Connected — Proxmox VE ${r.version}, ${r.online_nodes}/${r.nodes} nodes online`
        )
      else toast.error(r.error || "Probe failed")
    },
    onError: (e) => apiErrorToast(e),
  })

  const syncNow = useMutation({
    mutationFn: (s: VirtualizationSource) =>
      api<{
        ok: boolean
        vms?: number
        interfaces?: number
        ips?: number
        error?: string
      }>(`/api/virtualization-sources/${s.id}/sync/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (r.ok)
        toast.success(
          `Synced: ${r.vms ?? 0} VMs, ${r.interfaces ?? 0} interfaces, ${r.ips ?? 0} IPs`
        )
      else toast.error(r.error || "Sync failed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<VirtualizationSource>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            {row.original.name}
            {!row.original.enabled && (
              <Badge variant="secondary" className="text-[10px]">
                disabled
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: "Platform",
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px]">
            {row.original.kind_display}
          </Badge>
        ),
      },
      {
        id: "mode",
        accessorKey: "sync_mode",
        header: "Mode",
        cell: ({ row }) => {
          const m = row.original.sync_mode
          const label =
            m === "auto" ? "automatic" : m === "manual" ? "manual" : "review"
          return (
            <span className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {label}
              </Badge>
              {row.original.pending_count > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setReviewing(row.original)}
                >
                  <Inbox className="h-3.5 w-3.5" />
                  {row.original.pending_count} to review
                </Button>
              )}
            </span>
          )
        },
      },
      {
        id: "host",
        accessorKey: "host",
        header: "API",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            https://{row.original.host}:{row.original.port}
          </span>
        ),
      },
      {
        id: "status",
        header: "Last sync",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original
          return (
            <span className="flex items-center gap-2">
              {!s.last_sync_status ? (
                <span className="text-xs text-muted-foreground">
                  never synced
                </span>
              ) : s.last_sync_status === "ok" ? (
                <Badge variant="success" className="text-[10px]">
                  ok
                </Badge>
              ) : (
                <Badge
                  variant="destructive"
                  className="text-[10px]"
                  title={s.last_sync_error}
                >
                  failed
                </Badge>
              )}
              {s.last_sync_at && <TimeCell iso={s.last_sync_at} />}
            </span>
          )
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => del.mutate(row.original) : undefined}
            extra={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={test.isPending}
                  onClick={() => test.mutate(row.original)}
                >
                  <Plug className="h-3.5 w-3.5" /> Test
                </Button>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={syncNow.isPending}
                    onClick={() => syncNow.mutate(row.original)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {syncNow.isPending ? "Syncing…" : "Sync"}
                  </Button>
                )}
              </>
            }
          />
        ),
      },
    ],
    [canEdit, canDelete, del, test, syncNow]
  )

  return (
    <ListPageShell
      title="Virtualization sources"
      count={query.data ? rows.length : undefined}
      query={query}
      search={{ value: q, onChange: setQ, placeholder: "Filter sources…" }}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add source
          </Button>
        )
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No virtualization sources.">
          Connect a Proxmox VE cluster with an API token and Danbyte imports its
          virtual machines, their interfaces and guest IPs into the cluster/VM
          inventory — and keeps them fresh.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="host"
          tableId="virtualization-sources"
        />
      )}
      {creating && <SourceDialog onOpenChange={setCreating} />}
      {editing && (
        <SourceDialog
          source={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      {reviewing && (
        <VirtChangesDialog
          source={reviewing}
          onOpenChange={(o) => !o && setReviewing(null)}
        />
      )}
    </ListPageShell>
  )
}

function SourceDialog({
  source,
  onOpenChange,
}: {
  /** Present = edit; absent = create. */
  source?: VirtualizationSource
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const isEdit = !!source
  const [name, setName] = useState(source?.name ?? "")
  const [host, setHost] = useState(source?.host ?? "")
  const [port, setPort] = useState(String(source?.port ?? 8006))
  const [verifySsl, setVerifySsl] = useState(source?.verify_ssl ?? false)
  const [tokenId, setTokenId] = useState("")
  const [secret, setSecret] = useState("")
  const [syncMode, setSyncMode] = useState<string>(
    source?.sync_mode ?? "review"
  )
  const [interval, setInterval] = useState(
    String(source?.poll_interval_minutes ?? 10)
  )
  const [enabled, setEnabled] = useState(source?.enabled ?? true)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind: "proxmox",
        host: host.trim(),
        port: Number(port) || 8006,
        verify_ssl: verifySsl,
        sync_mode: syncMode,
        poll_interval_minutes: Number(interval) || 10,
        enabled,
      }
      if (tokenId.trim()) body.token_id = tokenId.trim()
      if (secret) body.secret = secret
      if (isEdit)
        return api<VirtualizationSource>(
          `/api/virtualization-sources/${source.id}/`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
      return api<VirtualizationSource>("/api/virtualization-sources/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      toast.success(isEdit ? "Source saved" : "Source added")
      qc.invalidateQueries({ queryKey: ["virtualization-sources"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const valid =
    name.trim() && host.trim() && (isEdit || (tokenId.trim() && secret))

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Proxmox source" : "Add Proxmox source"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder="DB-CLUSTER01"
          />
          <FormText
            label="Host"
            value={host}
            onChange={setHost}
            required
            placeholder="10.0.0.11"
            info="Any cluster node works — the API answers cluster-wide."
          />
          <FormText label="API port" value={port} onChange={setPort} />
          <FormSelect
            label="Sync mode"
            value={syncMode}
            onChange={(v) => setSyncMode(v ?? "review")}
            info="Automatic mirrors the hypervisor (it becomes the source of truth). Review polls on a schedule but only applies changes you accept. Manual detects only when you sync by hand — both keep Danbyte the source of truth."
            options={[
              { value: "review", label: "Review — apply on accept" },
              { value: "auto", label: "Automatic — mirror" },
              { value: "manual", label: "Manual — detect on demand" },
            ]}
          />
          <FormText
            label="Poll interval (minutes)"
            value={interval}
            onChange={setInterval}
          />
          <FormText
            label="API token id"
            value={tokenId}
            onChange={setTokenId}
            mono
            placeholder={isEdit ? "(unchanged)" : "danbyte@pam!sync"}
            info="Datacenter → Permissions → API Tokens. The PVEAuditor role is enough for read sync."
            required={!isEdit}
          />
          <FormText
            label="Token secret"
            value={secret}
            onChange={setSecret}
            type="password"
            placeholder={isEdit ? "(unchanged)" : ""}
            required={!isEdit}
          />
          <div className="flex flex-col justify-end gap-2 pb-1">
            <FormCheckbox
              label="Verify TLS certificate"
              checked={verifySsl}
              onChange={setVerifySsl}
            />
            {isEdit && (
              <FormCheckbox
                label="Enabled"
                checked={enabled}
                onChange={setEnabled}
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
