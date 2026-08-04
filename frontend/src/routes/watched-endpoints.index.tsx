import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, WatchedEndpoint } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader } from "@/components/data-table"
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

function WatchedEndpointsPage() {
  const { canDo } = useMe()
  const [formOpen, setFormOpen] = useState(false)

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
                <span className="text-muted-foreground"> (SNI {r.server_name})</span>
              )}
            </span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
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
        ),
      },
      {
        id: "certificate",
        header: "Certificate",
        cell: ({ row }) =>
          row.original.last_certificate ? (
            <Link
              to="/certificates/$id"
              params={{ id: row.original.last_certificate }}
              className="font-mono text-[12px] text-primary hover:underline"
            >
              {(row.original.last_certificate_fingerprint ?? "").slice(0, 12) ||
                "view"}…
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "expires",
        header: "Expires in",
        cell: ({ row }) => {
          const days = row.original.last_detail?.expires_in_days as
            | number
            | undefined
          if (days === undefined) return <span className="text-muted-foreground">—</span>
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
        canDo("watchedendpoint", "add") ? (
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Watch an endpoint
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No watched endpoints yet.">
          Add a <span className="font-mono">host:port</span> and Danbyte reads its
          TLS certificate on a schedule — no device needed. Observed certificates
          land in the Certificates inventory, with expiry, fingerprint-change and
          chain state.
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} />
      )}
      <EndpointFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </ListPageShell>
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
      <RefreshCw className={`h-3.5 w-3.5 ${m.isPending ? "animate-spin" : ""}`} />
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
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [host, setHost] = useState("")
  const [port, setPort] = useState("443")
  const [sni, setSni] = useState("")
  const [interval, setInterval] = useState("86400")
  const [enabled, setEnabled] = useState(true)

  const save = useMutation({
    mutationFn: () =>
      api("/api/monitoring/watched-endpoints/", {
        method: "POST",
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 443,
          server_name: sni.trim(),
          interval_seconds: Number(interval) || 86400,
          enabled,
        }),
      }),
    onSuccess: () => {
      toast.success("Watching endpoint")
      qc.invalidateQueries({ queryKey: ["watched-endpoints"] })
      onOpenChange(false)
      setHost("")
      setPort("443")
      setSni("")
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Watch an endpoint</DialogTitle>
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
          <FormText label="Port" value={port} onChange={setPort} type="number" mono />
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
          <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!host.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Adding…" : "Watch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
