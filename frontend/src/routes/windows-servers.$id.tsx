import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DhcpLease,
  type DhcpReservation,
  type DhcpScope,
  type Paginated,
  type WindowsConnection,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { InfoTip } from "@/components/ui/info-tip"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { RowActions } from "@/components/row-actions"
import { TimeCell } from "@/components/cells/time-ago"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DhcpReservationDialog } from "@/components/integrations/dhcp-reservation-dialog"
import { DnsPanel } from "@/components/integrations/dns-panel"
import { WindowsConnectionDialog } from "@/components/integrations/windows-connection-dialog"
import { SyncStatusBadge, roleBadges } from "./windows-servers.index"

const OBJECT_TYPE = "integrations.windowsserverconnection"

type Tab =
  | "overview"
  | "reservations"
  | "leases"
  | "dns"
  | "journal"
  | "history"
const TABS: readonly Tab[] = [
  "overview",
  "reservations",
  "leases",
  "dns",
  "journal",
  "history",
]

export const Route = createFileRoute("/windows-servers/$id")({
  component: WindowsServerDetail,
})

function WindowsServerDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["windows-connection", id],
    queryFn: () => api<WindowsConnection>(`/api/windows-connections/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body conn={q.data} />
}

function useScopes(connId: string) {
  return useQuery({
    queryKey: ["dhcp-scopes", connId],
    queryFn: () =>
      api<Paginated<DhcpScope>>(
        `/api/dhcp-scopes/?connection=${connId}&page_size=200`
      ),
  })
}

function Body({ conn }: { conn: WindowsConnection }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState(false)
  const scopes = useScopes(conn.id)
  const scopeRows = scopes.data?.results ?? []
  const driftCount = scopeRows.reduce((n, s) => n + s.drift_count, 0)

  const syncNow = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; dhcp?: Record<string, number> }>(
        `/api/windows-connections/${conn.id}/sync/`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (r) => {
      const c = r.dhcp
      toast.success(
        c
          ? `Synced: ${c.scopes} scopes, ${c.reservations} reservations` +
              (c.drift ? `, ${c.drift} drifted` : "")
          : "Synced"
      )
      qc.invalidateQueries({ queryKey: ["windows-connection"] })
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
      qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
      qc.invalidateQueries({ queryKey: ["dhcp-leases"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const test = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean
        ps_version?: string
        dhcp_scopes?: number
        dns_zones?: number
        dhcp_error?: string
        dns_error?: string
        error?: string
      }>(`/api/windows-connections/${conn.id}/test/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (r.ok) {
        const bits = [
          r.ps_version && `PowerShell ${r.ps_version}`,
          r.dhcp_scopes !== undefined && `${r.dhcp_scopes} DHCP scopes`,
          r.dns_zones !== undefined && `${r.dns_zones} DNS zones`,
        ].filter(Boolean)
        toast.success(`Connected — ${bits.join(", ")}`)
      } else {
        toast.error(r.dhcp_error || r.dns_error || r.error || "Probe failed")
      }
    },
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: () =>
      api(`/api/windows-connections/${conn.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Server removed")
      nav({ to: "/windows-servers" })
    },
    onError: (e) => apiErrorToast(e),
  })

  const canChange = canDo("windowsserverconnection", "change")

  return (
    <DetailShell
      backTo="/windows-servers"
      backLabel="Windows servers"
      title={conn.name}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            <Plug className="h-3.5 w-3.5" />
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          {canChange && (
            <Button
              variant="outline"
              size="sm"
              disabled={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
          )}
          {canChange && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {canDo("windowsserverconnection", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => del.mutate()}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={conn.name}
          badges={
            <>
              {roleBadges(conn)}
              <Badge
                variant={conn.enabled ? "success" : "secondary"}
                className="text-[10px]"
              >
                {conn.enabled ? "enabled" : "disabled"}
              </Badge>
              <SyncStatusBadge conn={conn} />
            </>
          }
          subtitle={
            <span className="font-mono text-[12px]">
              {conn.use_tls ? "https" : "http"}://{conn.host}:{conn.port}/wsman
            </span>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "reservations",
          label: "Reservations",
          count: driftCount || undefined,
        },
        { value: "leases", label: "Leases" },
        { value: "dns", label: "DNS" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <Overview conn={conn} scopes={scopeRows} loaded={!!scopes.data} />
      </DetailTab>
      <DetailTab value="reservations">
        <Reservations conn={conn} scopes={scopeRows} />
      </DetailTab>
      <DetailTab value="leases">
        <Leases conn={conn} scopes={scopeRows} />
      </DetailTab>
      <DetailTab value="dns">
        <DnsPanel conn={conn} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={conn.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={conn.id} />
      </DetailTab>
      {editing && (
        <WindowsConnectionDialog
          connection={conn}
          onOpenChange={(o) => !o && setEditing(false)}
        />
      )}
    </DetailShell>
  )
}

function Overview({
  conn,
  scopes,
  loaded,
}: {
  conn: WindowsConnection
  scopes: DhcpScope[]
  loaded: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canScope = canDo("dhcpscope", "change")

  const setLeaseSync = useMutation({
    mutationFn: ({ scope, on }: { scope: DhcpScope; on: boolean }) =>
      api<DhcpScope>(`/api/dhcp-scopes/${scope.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ lease_sync: on }),
      }),
    onSuccess: (_, { on }) => {
      toast.success(
        on
          ? "Lease sync on — leases arrive on the next sync"
          : "Lease sync off — synced leases are removed on the next sync"
      )
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const connection: KvRow[] = [
    {
      label: "Host",
      value: (
        <span className="font-mono text-xs">
          {conn.host}:{conn.port}
        </span>
      ),
    },
    {
      label: "Transport",
      value: conn.use_tls
        ? conn.verify_ssl
          ? "TLS (verified)"
          : "TLS (unverified)"
        : "HTTP",
    },
    { label: "Authentication", value: conn.auth_mode.toUpperCase() },
    { label: "Username", value: conn.username },
    { label: "Password", value: conn.password_set ? "set" : "not set" },
    { label: "Poll interval", value: `${conn.poll_interval_minutes} min` },
    {
      label: "Last sync",
      value: conn.last_sync_at ? <TimeCell iso={conn.last_sync_at} /> : dash,
    },
  ]
  if (conn.last_sync_error)
    connection.push({
      label: "Last error",
      value: (
        <span className="text-xs text-destructive">{conn.last_sync_error}</span>
      ),
    })

  const scopeColumns = useMemo<ColumnDef<DhcpScope>[]>(
    () => [
      {
        id: "scope",
        accessorKey: "scope_id",
        header: "Scope",
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.scope_id}</span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name || dash,
      },
      {
        id: "prefix",
        header: "Prefix",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.prefix ? (
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.prefix }}
              className="link font-mono text-xs"
            >
              {row.original.prefix_cidr}
            </Link>
          ) : (
            dash
          ),
      },
      {
        id: "range",
        header: "Range",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.start_range}–{row.original.end_range}
          </span>
        ),
      },
      {
        id: "state",
        accessorKey: "state",
        header: "State",
        cell: ({ row }) => (
          <Badge
            variant={row.original.state === "Active" ? "success" : "secondary"}
            className="text-[10px]"
          >
            {row.original.state || "unknown"}
          </Badge>
        ),
      },
      {
        id: "reservations",
        header: "Reservations",
        cell: ({ row }) => (
          <span className="num">
            {row.original.reservation_count}
            {row.original.drift_count > 0 && (
              <Badge variant="destructive" className="ml-2 text-[10px]">
                {row.original.drift_count} drifted
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "lease_sync",
        header: "Lease sync",
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            checked={row.original.lease_sync}
            disabled={!canScope || setLeaseSync.isPending}
            onCheckedChange={(on) =>
              setLeaseSync.mutate({ scope: row.original, on })
            }
            aria-label="Lease sync"
          />
        ),
      },
    ],
    [canScope, setLeaseSync]
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <KvCard title="Connection" rows={connection} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">DHCP scopes</h3>
        {loaded && scopes.length === 0 ? (
          <EmptyState title="No scopes synced yet.">
            Run a sync (or wait for the next scheduled one) to pull this
            server's DHCP scopes in.
          </EmptyState>
        ) : (
          <DataTable
            data={scopes}
            columns={scopeColumns}
            tableId="dhcp-scopes"
            flexColumn="name"
          />
        )}
      </div>
    </div>
  )
}

function Reservations({
  conn,
  scopes,
}: {
  conn: WindowsConnection
  scopes: DhcpScope[]
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("dhcpreservation", "add")
  const canEdit = canDo("dhcpreservation", "change")
  const canDelete = canDo("dhcpreservation", "delete")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<DhcpReservation | null>(null)

  const query = useQuery({
    queryKey: ["dhcp-reservations", conn.id],
    queryFn: () =>
      api<Paginated<DhcpReservation>>(
        `/api/dhcp-reservations/?connection=${conn.id}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
    qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
  }

  const del = useMutation({
    mutationFn: (r: DhcpReservation) =>
      api(`/api/dhcp-reservations/${r.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Reservation removed from the server")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const resolve = useMutation({
    mutationFn: ({
      r,
      strategy,
    }: {
      r: DhcpReservation
      strategy: "accept" | "push"
    }) =>
      api(`/api/dhcp-reservations/${r.id}/resolve/`, {
        method: "POST",
        body: JSON.stringify({ strategy }),
      }),
    onSuccess: (_, { strategy }) => {
      toast.success(
        strategy === "accept"
          ? "Server's version accepted"
          : "Danbyte's version pushed back to the server"
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<DhcpReservation>[]>(
    () => [
      {
        id: "ip",
        accessorKey: "ip",
        header: "IP",
        cell: ({ row }) =>
          row.original.ip_address ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.ip_address }}
              className="link font-mono text-xs"
            >
              {row.original.ip}
            </Link>
          ) : (
            <span className="font-mono text-xs">{row.original.ip}</span>
          ),
      },
      {
        id: "mac",
        accessorKey: "mac",
        header: "MAC",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.mac}
          </span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name || dash,
      },
      {
        id: "scope",
        accessorKey: "scope_display",
        header: "Scope",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.scope_display}
          </span>
        ),
      },
      {
        id: "origin",
        header: "Origin",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.managed ? (
            <Badge variant="outline" className="text-[10px]">
              Danbyte
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">server</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) => <DriftCell r={row.original} resolve={resolve} />,
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => setEditing(row.original) : undefined}
            onDelete={canDelete ? () => del.mutate(row.original) : undefined}
          />
        ),
      },
    ],
    [canEdit, canDelete, del, resolve]
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          Reservations
          <InfoTip>
            Reservations created or edited here are pushed straight to the DHCP
            server. Rows marked <span className="font-medium">Danbyte</span> are
            watched for outside changes.
          </InfoTip>
        </h3>
        {canAdd && scopes.length > 0 && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New reservation
          </Button>
        )}
      </div>
      {query.data && rows.length === 0 ? (
        <EmptyState title="No reservations.">
          Sync the server to pull existing reservations in, or create one here
          to push it out.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="dhcp-reservations"
          flexColumn="name"
        />
      )}
      {creating && (
        <DhcpReservationDialog
          scopes={scopes}
          onOpenChange={(o) => !o && setCreating(false)}
        />
      )}
      {editing && (
        <DhcpReservationDialog
          scopes={scopes}
          reservation={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  )
}

function DriftCell({
  r,
  resolve,
}: {
  r: DhcpReservation
  resolve: {
    mutate: (v: { r: DhcpReservation; strategy: "accept" | "push" }) => void
    isPending: boolean
  }
}) {
  if (!r.drift) return <span className="text-xs text-muted-foreground">—</span>
  const label =
    r.drift === "missing" ? "missing on server" : "modified on server"
  const detail = Object.entries(r.drift_detail || {})
    .map(([f, v]) => `${f}: ${String(v.danbyte)} → ${String(v.server)}`)
    .join(", ")
  return (
    <span className="flex items-center gap-1.5">
      <Badge variant="destructive" className="text-[10px]" title={detail}>
        {label}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px]"
        disabled={resolve.isPending}
        onClick={() => resolve.mutate({ r, strategy: "accept" })}
      >
        Accept
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px]"
        disabled={resolve.isPending}
        onClick={() => resolve.mutate({ r, strategy: "push" })}
      >
        Push ours
      </Button>
    </span>
  )
}

function Leases({
  conn,
  scopes,
}: {
  conn: WindowsConnection
  scopes: DhcpScope[]
}) {
  const query = useQuery({
    queryKey: ["dhcp-leases", conn.id],
    queryFn: () =>
      api<Paginated<DhcpLease>>(
        `/api/dhcp-leases/?connection=${conn.id}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []
  const anyOptIn = scopes.some((s) => s.lease_sync)

  const columns = useMemo<ColumnDef<DhcpLease>[]>(
    () => [
      {
        id: "ip",
        accessorKey: "ip",
        header: "IP",
        cell: ({ row }) =>
          row.original.ip_address ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.ip_address }}
              className="link font-mono text-xs"
            >
              {row.original.ip}
            </Link>
          ) : (
            <span className="font-mono text-xs">{row.original.ip}</span>
          ),
      },
      {
        id: "mac",
        accessorKey: "mac",
        header: "MAC",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.mac || "—"}
          </span>
        ),
      },
      {
        id: "hostname",
        accessorKey: "hostname",
        header: "Hostname",
        cell: ({ row }) => row.original.hostname || dash,
      },
      {
        id: "state",
        accessorKey: "address_state",
        header: "State",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.address_state || "—"}
          </span>
        ),
      },
      {
        id: "expires",
        header: "Expires",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.expires_at ? (
            <TimeCell iso={row.original.expires_at} />
          ) : (
            dash
          ),
      },
    ],
    []
  )

  if (query.data && rows.length === 0)
    return (
      <EmptyState title={anyOptIn ? "No leases yet." : "Lease sync is off."}>
        {anyOptIn
          ? "Leases appear here after the next sync of an opted-in scope."
          : "Leases churn constantly, so they're opt-in per scope — flip the Lease sync switch on a scope in the Overview tab."}
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="dhcp-leases"
      flexColumn="hostname"
    />
  )
}
