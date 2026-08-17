import { Link } from "@tanstack/react-router"

import type {
  DashRecentDevice,
  DashRecentIp,
  DashRecentPrefix,
} from "@/lib/api"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { ColorBadge } from "@/components/cells/color-badge"

// Compact, border-defined tables matching the data-table look on list pages —
// the shared SimpleTable *is* that look, so the widgets use it directly.

const PREFIX_COLUMNS: SimpleColumn<DashRecentPrefix>[] = [
  {
    id: "prefix",
    header: "Prefix",
    cell: (p) => (
      <Link
        to="/prefixes/$id"
        params={{ id: p.id }}
        className="link font-mono font-medium"
      >
        {p.cidr}
      </Link>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (p) => <span className="text-muted-foreground">{p.status}</span>,
  },
  {
    id: "site",
    header: "Site",
    flex: true,
    cell: (p) => <span className="text-muted-foreground">{p.site ?? "—"}</span>,
  },
  {
    id: "ips",
    header: "IPs",
    align: "right",
    cell: (p) => (
      <span className="num text-muted-foreground">{p.ip_count}</span>
    ),
  },
]

export function RecentPrefixes({ rows }: { rows: DashRecentPrefix[] }) {
  if (!rows.length) return <Empty />
  return (
    <SimpleTable columns={PREFIX_COLUMNS} data={rows} getRowKey={(p) => p.id} />
  )
}

const DEVICE_COLUMNS: SimpleColumn<DashRecentDevice>[] = [
  {
    id: "device",
    header: "Device",
    cell: (x) => (
      <Link
        to="/devices/$id"
        params={{ id: x.id }}
        className="link font-medium"
      >
        {x.name}
      </Link>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (x) => <span className="text-muted-foreground">{x.status}</span>,
  },
  {
    id: "type",
    header: "Type",
    cell: (x) => <span className="text-muted-foreground">{x.type ?? "—"}</span>,
  },
  {
    id: "site",
    header: "Site",
    flex: true,
    cell: (x) => <span className="text-muted-foreground">{x.site ?? "—"}</span>,
  },
]

export function RecentDevices({ rows }: { rows: DashRecentDevice[] }) {
  if (!rows.length) return <Empty />
  return (
    <SimpleTable columns={DEVICE_COLUMNS} data={rows} getRowKey={(x) => x.id} />
  )
}

const IP_COLUMNS: SimpleColumn<DashRecentIp>[] = [
  {
    id: "address",
    header: "Address",
    cell: (x) => (
      <Link
        to="/ips/$id"
        params={{ id: x.id }}
        className="link font-mono font-medium"
      >
        {x.ip}
      </Link>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (x) =>
      x.status ? (
        <ColorBadge name={x.status} color={x.status_color || undefined} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "dns",
    header: "DNS name",
    flex: true,
    cell: (x) => (
      <span className="font-mono text-xs text-muted-foreground">
        {x.dns ?? "—"}
      </span>
    ),
  },
]

export function RecentIps({ rows }: { rows: DashRecentIp[] }) {
  if (!rows.length) return <Empty />
  return (
    <SimpleTable columns={IP_COLUMNS} data={rows} getRowKey={(x) => x.id} />
  )
}

function Empty() {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
      Nothing yet.
    </div>
  )
}
