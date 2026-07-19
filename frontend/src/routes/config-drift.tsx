import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import {
  api,
  type DeviceConfigStateRow,
  type Paginated,
  type SnmpDriftRow,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { DriftStatusBadge } from "@/components/drift-status-badge"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/config-drift")({
  component: ConfigDriftPage,
})

type Tab = "config" | "snmp"
const STATUSES = ["drift", "in_sync", "unknown", "error"] as const

function ConfigDriftPage() {
  const [tab, setTab] = useState<Tab>("config")

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="text-base font-semibold">Drift</h1>
        <SegmentedTabs
          className="ml-2"
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          items={[
            { value: "config", label: "Config drift" },
            { value: "snmp", label: "SNMP drift" },
          ]}
        />
      </header>
      {tab === "config" ? <ConfigTab /> : <SnmpTab />}
    </div>
  )
}

// ── Ansible config-drift (reported by your runner) ──────────────────────────
function ConfigTab() {
  const [status, setStatus] = useState<string>("all")

  const query = useQuery({
    queryKey: ["config-states", status],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== "all") p.set("status", status)
      return api<Paginated<DeviceConfigStateRow>>(
        `/api/config-states/?${p.toString()}`
      )
    },
    refetchInterval: 30_000,
  })

  const rows = query.data?.results ?? []
  const driftCount = rows.filter((r) => r.status === "drift").length
  const columns = useMemo<ColumnDef<DeviceConfigStateRow>[]>(
    () => [
      {
        id: "device",
        accessorKey: "device_name",
        header: "Device",
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.device }}
            className="font-medium hover:underline"
          >
            {row.original.device_name}
          </Link>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <DriftStatusBadge status={row.original.status} />,
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Source",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.source || "—"}
          </span>
        ),
      },
      {
        id: "template",
        accessorKey: "template_name",
        header: "Template",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.template_name || "—"}
          </span>
        ),
      },
      {
        id: "reported",
        header: "Last reported",
        cell: ({ row }) =>
          row.original.reported_at ? (
            <TimeCell iso={row.original.reported_at} align="right" />
          ) : (
            <span className="block text-right text-xs text-muted-foreground">
              —
            </span>
          ),
      },
    ],
    []
  )

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
        {query.data && (
          <Badge variant={driftCount > 0 ? "warning" : "secondary"}>
            {driftCount > 0 ? `${driftCount} drifted` : `${rows.length}`}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {query.isError && <QueryError error={query.error} />}
        {query.data &&
          (rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No config state reported yet. Have your runner POST each device's
              actual config to{" "}
              <span className="font-mono text-[12px]">
                /api/devices/&lt;id&gt;/config-state/
              </span>{" "}
              after a render/compare, and drift shows up here.
            </p>
          ) : (
            <DataTable
              data={rows}
              columns={columns}
              flexColumn="source"
              tableId="config-drift"
            />
          ))}
      </div>
    </>
  )
}

// ── SNMP drift (observed-vs-intended, computed by Danbyte) ───────────────────
const SNMP_STATUSES = ["drift", "in_sync", "unreachable"] as const

function snmpDriftSummary(r: SnmpDriftRow): string {
  if (r.status === "unreachable") return "device unreachable"
  if (r.drift_count === 0) return "—"
  const parts: string[] = []
  if (r.by_kind.device_field) parts.push("name")
  const ifaces = r.interfaces_drifted
  if (ifaces) parts.push(`${ifaces} interface${ifaces === 1 ? "" : "s"}`)
  return parts.join(" · ") || `${r.drift_count}`
}

function SnmpDriftStatusBadge({ row }: { row: SnmpDriftRow }) {
  if (row.status === "unreachable")
    return <Badge variant="secondary">Unreachable</Badge>
  if (row.status === "in_sync") return <Badge variant="success">In sync</Badge>
  return <Badge variant="warning">{row.drift_count} drifted</Badge>
}

function SnmpTab() {
  const [status, setStatus] = useState<string>("all")

  const query = useQuery({
    queryKey: ["snmp-drift", status],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== "all") p.set("status", status)
      return api<{ count: number; results: SnmpDriftRow[] }>(
        `/api/monitoring/snmp-drift/?${p.toString()}`
      )
    },
    refetchInterval: 30_000,
  })

  const rows = query.data?.results ?? []
  const driftCount = rows.filter((r) => r.status === "drift").length
  const columns = useMemo<ColumnDef<SnmpDriftRow>[]>(
    () => [
      {
        id: "device",
        accessorKey: "device_name",
        header: "Device",
        cell: ({ row }) => (
          <Link
            to="/devices/$id"
            params={{ id: row.original.device }}
            className="font-medium hover:underline"
          >
            {row.original.device_name}
          </Link>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <SnmpDriftStatusBadge row={row.original} />,
      },
      {
        id: "drift",
        header: "Drift",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {snmpDriftSummary(row.original)}
          </span>
        ),
      },
      {
        id: "profile",
        accessorKey: "profile_name",
        header: "Profile",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.profile_name || "—"}
          </span>
        ),
      },
      {
        id: "polled",
        header: "Last polled",
        cell: ({ row }) =>
          row.original.polled_at ? (
            <TimeCell iso={row.original.polled_at} align="right" />
          ) : (
            <span className="block text-right text-xs text-muted-foreground">
              —
            </span>
          ),
      },
    ],
    []
  )

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
        {query.data && (
          <Badge variant={driftCount > 0 ? "warning" : "secondary"}>
            {driftCount > 0 ? `${driftCount} drifted` : `${rows.length}`}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {SNMP_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {query.isError && <QueryError error={query.error} />}
        {query.data &&
          (rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No SNMP-polled devices yet. Add an{" "}
              <span className="font-mono text-[12px]">SNMP profile</span>, bind
              it to a device, and poll it from the device's{" "}
              <span className="font-medium">Observed (SNMP)</span> card — drift
              between the observed state and Danbyte's intent shows up here.
            </p>
          ) : (
            <DataTable
              data={rows}
              columns={columns}
              flexColumn="drift"
              tableId="snmp-drift"
            />
          ))}
      </div>
    </>
  )
}
