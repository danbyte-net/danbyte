import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, WatchedEndpoint } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormText } from "@/components/forms"

export const Route = createFileRoute("/watched-endpoints/")({
  component: WatchedEndpointsPage,
})

const STATUS_VARIANT: Record<
  WatchedEndpoint["last_status"],
  "success" | "secondary" | "destructive" | "outline"
> = {
  up: "success",
  degraded: "secondary",
  down: "destructive",
  unknown: "outline",
  "": "outline",
}

function StatusBadge({ ep }: { ep: WatchedEndpoint }) {
  const label = ep.last_status || "never run"
  return <Badge variant={STATUS_VARIANT[ep.last_status]}>{label}</Badge>
}

/** Plain-language reason behind the status, from the last observation. */
function statusReason(ep: WatchedEndpoint): string {
  const d = ep.last_detail ?? {}
  if (ep.last_status === "up") {
    if (ep.allow_self_signed && d.self_signed)
      return "self-signed, accepted (in validity window)"
    return "chain verified, in validity window"
  }
  if (ep.last_status === "down")
    return (d.error as string) || "no TLS — connection refused or timed out"
  if (ep.last_status === "degraded") {
    if (d.expired) return "certificate has expired"
    if (d.not_yet_valid) return "certificate is not yet valid"
    if (d.self_signed) return "self-signed certificate"
    if (d.validity === "unverified") return "chain does not verify (untrusted)"
    return "reachable but the certificate is not trusted"
  }
  if (ep.last_status === "unknown")
    return (d.error as string) || "check could not run (config/policy)"
  return "not checked yet"
}

function WatchedEndpointsPage() {
  const { canDo } = useMe()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<WatchedEndpoint | null>(null)
  const [selected, setSelected] = useState<WatchedEndpoint[]>([])

  const query = useQuery({
    queryKey: ["watched-endpoints"],
    queryFn: () =>
      api<Paginated<WatchedEndpoint>>(
        "/api/monitoring/watched-endpoints/?page_size=500"
      ),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const canManage = canDo("watchedendpoint", "change")

  const columns = useMemo<ColumnDef<WatchedEndpoint>[]>(
    () => [
      ...(canManage ? [selectionColumn<WatchedEndpoint>()] : []),
      {
        id: "endpoint",
        accessorFn: (r) => `${r.host}:${r.port}`,
        header: ({ column }) => <SortHeader column={column} label="Endpoint" />,
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="font-mono text-[13px]">
              {r.host}:{r.port}
              {r.server_name && r.server_name !== r.host && (
                <span className="text-muted-foreground">
                  {" "}
                  (SNI {r.server_name})
                </span>
              )}
            </span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <StatusBadge ep={row.original} />
              {row.original.last_detail?.fingerprint_changed ? (
                <Badge
                  variant="secondary"
                  className="text-amber-600 dark:text-amber-400"
                  title="The served certificate changed since the last check"
                >
                  cert changed
                </Badge>
              ) : null}
            </span>
            {row.original.last_status && (
              <span className="text-[11px] text-muted-foreground">
                {statusReason(row.original)}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "certificate",
        header: "Certificate",
        cell: ({ row }) => {
          const r = row.original
          if (!r.last_certificate)
            return <span className="text-muted-foreground">—</span>
          const label =
            r.last_certificate_subject_cn?.trim() || "View certificate"
          return (
            <Link
              to="/certificates/$id"
              params={{ id: r.last_certificate }}
              className="text-primary hover:underline"
              title={r.last_certificate_fingerprint ?? undefined}
            >
              {label}
            </Link>
          )
        },
      },
      {
        id: "expires",
        header: "Expires in",
        cell: ({ row }) => {
          const days = row.original.last_detail?.expires_in_days as
            | number
            | undefined
          if (days === undefined)
            return <span className="text-muted-foreground">—</span>
          const cls =
            days < 0
              ? "text-destructive"
              : days < 14
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
          return (
            <span className={cls}>
              {days < 0 ? "expired" : `${Math.round(days)} days`}
            </span>
          )
        },
      },
      {
        id: "checked",
        header: "Last checked",
        cell: ({ row }) =>
          row.original.last_run_at ? (
            <TimeCell iso={row.original.last_run_at} />
          ) : (
            <span className="text-muted-foreground">never</span>
          ),
      },
      {
        id: "interval",
        header: "Every",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {Math.round(row.original.interval_seconds / 3600)}h
          </span>
        ),
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) =>
          row.original.enabled ? (
            <Badge variant="secondary">On</Badge>
          ) : (
            <Badge variant="outline">Off</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canManage ? (
            <div className="flex justify-end gap-1">
              <CheckNowButton ep={row.original} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(row.original)}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
              <DeleteButton ep={row.original} />
            </div>
          ) : null,
      },
    ],
    [canManage]
  )

  return (
    <ListPageShell
      title="Watched endpoints"
      count={rows.length}
      actions={
        <div className="flex items-center gap-2">
          {canManage && selected.length > 0 && (
            <BulkDeleteButton
              endpoints={selected}
              onDone={() => setSelected([])}
            />
          )}
          {canDo("watchedendpoint", "add") && (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Watch an endpoint
            </Button>
          )}
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No watched endpoints yet.">
          Add a <span className="font-mono">host:port</span> and Danbyte reads
          its TLS certificate on a schedule — no device needed. Observed
          certificates land in the Certificates inventory, with expiry,
          fingerprint-change and chain state.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          onSelectedRowsChange={canManage ? setSelected : undefined}
          tableId="watched-endpoints"
        />
      )}
      <EndpointFormDialog open={formOpen} onOpenChange={setFormOpen} />
      <EndpointFormDialog
        key={editing?.id ?? "none"}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        endpoint={editing}
      />
    </ListPageShell>
  )
}

function BulkDeleteButton({
  endpoints,
  onDone,
}: {
  endpoints: WatchedEndpoint[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      api("/api/monitoring/watched-endpoints/bulk-delete/", {
        method: "POST",
        body: JSON.stringify({ ids: endpoints.map((e) => e.id) }),
      }),
    onSuccess: () => {
      toast.success(`Removed ${endpoints.length} endpoint(s)`)
      qc.invalidateQueries({ queryKey: ["watched-endpoints"] })
      setOpen(false)
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 className="h-3.5 w-3.5" /> Delete {endpoints.length}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove {endpoints.length} endpoint(s)?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Their schedules stop. Certificates already observed stay in the
            inventory.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={m.isPending}
              onClick={() => m.mutate()}
            >
              {m.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CheckNowButton({ ep }: { ep: WatchedEndpoint }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<WatchedEndpoint>(
        `/api/monitoring/watched-endpoints/${ep.id}/check-now/`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (d) => {
      toast.success(`Checked ${ep.host} — ${d.last_status}`)
      qc.invalidateQueries({ queryKey: ["watched-endpoints"] })
      qc.invalidateQueries({ queryKey: ["certificates"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      title="Check now"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      <RefreshCw
        className={`h-3.5 w-3.5 ${m.isPending ? "animate-spin" : ""}`}
      />
    </Button>
  )
}

function DeleteButton({ ep }: { ep: WatchedEndpoint }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/watched-endpoints/${ep.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Endpoint removed")
      qc.invalidateQueries({ queryKey: ["watched-endpoints"] })
      setOpen(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              Stop watching {ep.host}:{ep.port}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The schedule is removed. Certificates already observed stay in the
            inventory.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={m.isPending}
              onClick={() => m.mutate()}
            >
              {m.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function EndpointFormDialog({
  open,
  onOpenChange,
  endpoint,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  endpoint?: WatchedEndpoint | null
}) {
  const qc = useQueryClient()
  const editing = !!endpoint
  const [host, setHost] = useState(endpoint?.host ?? "")
  const [port, setPort] = useState(String(endpoint?.port ?? 443))
  const [sni, setSni] = useState(endpoint?.server_name ?? "")
  const [interval, setInterval] = useState(
    String(endpoint?.interval_seconds ?? 86400)
  )
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true)
  const [allowSelfSigned, setAllowSelfSigned] = useState(
    endpoint?.allow_self_signed ?? false
  )

  const save = useMutation({
    mutationFn: () =>
      api(
        editing
          ? `/api/monitoring/watched-endpoints/${endpoint!.id}/`
          : "/api/monitoring/watched-endpoints/",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            host: host.trim(),
            port: Number(port) || 443,
            server_name: sni.trim(),
            interval_seconds: Number(interval) || 86400,
            enabled,
            allow_self_signed: allowSelfSigned,
          }),
        }
      ),
    onSuccess: () => {
      toast.success(editing ? "Endpoint updated" : "Watching endpoint")
      qc.invalidateQueries({ queryKey: ["watched-endpoints"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit watched endpoint" : "Watch an endpoint"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <FormText
            label="Host"
            value={host}
            onChange={setHost}
            required
            placeholder="example.com"
            mono
          />
          <FormText
            label="Port"
            value={port}
            onChange={setPort}
            type="number"
            mono
          />
          <FormText
            label="Server name (SNI, optional)"
            value={sni}
            onChange={setSni}
            placeholder="defaults to the host"
            mono
          />
          <FormText
            label="Interval (seconds)"
            value={interval}
            onChange={setInterval}
            type="number"
            mono
            hint="How often to re-read the certificate. Daily (86400) is plenty."
          />
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />
          <FormCheckbox
            label="Accept self-signed certificate"
            checked={allowSelfSigned}
            onChange={setAllowSelfSigned}
            hint="For endpoints that are self-signed by design — reads healthy instead of degraded. Expiry is still flagged."
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!host.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? editing
                ? "Saving…"
                : "Adding…"
              : editing
                ? "Save"
                : "Watch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
