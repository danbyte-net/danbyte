import { createFileRoute } from "@tanstack/react-router"
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
import { deviceColumn } from "@/components/cells/device-cell"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { TimeCell } from "@/components/cells/time-ago"
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
    // Page-level tab strip over one ListPageShell per tab - the shell owns the
    // title/count/actions row and the loading/error triad for both tabs.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          items={[
            { value: "config", label: "Config drift" },
            { value: "snmp", label: "SNMP drift" },
          ]}
        />
      </div>
      {tab === "config" ? <ConfigTab /> : <SnmpTab />}
    </div>
  )
}

/** Status dropdown shared by both tabs' shell headers. */
function StatusFilter({
  value,
  onChange,
  statuses,
}: {
  value: string
  onChange: (v: string) => void
  statuses: readonly string[]
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All statuses</SelectItem>
        {statuses.map((s) => (
          <SelectItem key={s} value={s}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
      deviceColumn<DeviceConfigStateRow>({
        get: (r) => ({ id: r.device, name: r.device_name }),
        className: "font-medium",
      }),
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
            {row.original.source || "-"}
          </span>
        ),
      },
      {
        id: "template",
        accessorKey: "template_name",
        header: "Template",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.template_name || "-"}
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
              -
            </span>
          ),
      },
    ],
    []
  )

  return (
    <ListPageShell
      title="Config drift"
      count={query.data ? rows.length : undefined}
      actions={
        <>
          {driftCount > 0 && (
            <Badge variant="warning">{driftCount} drifted</Badge>
          )}
          <StatusFilter
            value={status}
            onChange={setStatus}
            statuses={STATUSES}
          />
        </>
      }
      query={query}
    >
      {rows.length === 0 && status === "all" ? (
        <EmptyState title="No config state reported yet.">
          Have your runner POST each device's actual config to{" "}
          <span className="font-mono text-[12px]">
            /api/devices/&lt;id&gt;/config-state/
          </span>{" "}
          after a render/compare, and drift shows up here.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="source"
          tableId="config-drift"
        />
      )}
    </ListPageShell>
  )
}

// ── SNMP drift (observed-vs-intended, computed by Danbyte) ───────────────────
const SNMP_STATUSES = ["drift", "in_sync", "unreachable"] as const

function snmpDriftSummary(r: SnmpDriftRow): string {
  if (r.status === "unreachable") return "device unreachable"
  if (r.drift_count === 0) return "-"
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
      deviceColumn<SnmpDriftRow>({
        get: (r) => ({ id: r.device, name: r.device_name }),
        className: "font-medium",
      }),
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
            {row.original.profile_name || "-"}
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
              -
            </span>
          ),
      },
    ],
    []
  )

  return (
    <ListPageShell
      title="SNMP drift"
      count={query.data ? rows.length : undefined}
      actions={
        <>
          {driftCount > 0 && (
            <Badge variant="warning">{driftCount} drifted</Badge>
          )}
          <StatusFilter
            value={status}
            onChange={setStatus}
            statuses={SNMP_STATUSES}
          />
        </>
      }
      query={query}
    >
      {rows.length === 0 && status === "all" ? (
        <EmptyState title="No SNMP-polled devices yet.">
          Add an <span className="font-mono text-[12px]">SNMP profile</span>,
          bind it to a device, and poll it from the device's{" "}
          <span className="font-medium">Observed (SNMP)</span> card - drift
          between the observed state and Danbyte's intent shows up here.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="drift"
          tableId="snmp-drift"
        />
      )}
    </ListPageShell>
  )
}
