import { Link } from "@tanstack/react-router"

import type {
  DashRecentDevice,
  DashRecentIp,
  DashRecentPrefix,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"

// Compact, border-defined tables matching the data-table look on list pages.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left text-[13px]">{children}</table>
    </div>
  )
}

const TH =
  "px-2 py-1.5 text-[10px] font-medium tracking-[0.06em] text-muted-foreground uppercase"
const TD = "px-2 py-1.5"

export function RecentPrefixes({ rows }: { rows: DashRecentPrefix[] }) {
  if (!rows.length) return <Empty />
  return (
    <Shell>
      <thead className="sticky top-0 bg-card">
        <tr>
          <th className={TH}>Prefix</th>
          <th className={TH}>Status</th>
          <th className={TH}>Site</th>
          <th className={`${TH} text-right`}>IPs</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">
        {rows.map((p) => (
          <tr key={p.id} className="hover:bg-muted/40">
            <td className={TD}>
              <Link
                to="/prefixes/$id"
                params={{ id: p.id }}
                className="font-mono font-medium hover:underline"
              >
                {p.cidr}
              </Link>
            </td>
            <td className={`${TD} text-muted-foreground`}>{p.status}</td>
            <td className={`${TD} truncate text-muted-foreground`}>
              {p.site ?? "—"}
            </td>
            <td
              className={`${TD} num text-right text-muted-foreground tabular-nums`}
            >
              {p.ip_count}
            </td>
          </tr>
        ))}
      </tbody>
    </Shell>
  )
}

export function RecentDevices({ rows }: { rows: DashRecentDevice[] }) {
  if (!rows.length) return <Empty />
  return (
    <Shell>
      <thead className="sticky top-0 bg-card">
        <tr>
          <th className={TH}>Device</th>
          <th className={TH}>Status</th>
          <th className={TH}>Type</th>
          <th className={TH}>Site</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">
        {rows.map((x) => (
          <tr key={x.id} className="hover:bg-muted/40">
            <td className={`${TD} font-medium`}>{x.name}</td>
            <td className={`${TD} text-muted-foreground`}>{x.status}</td>
            <td className={`${TD} truncate text-muted-foreground`}>
              {x.type ?? "—"}
            </td>
            <td className={`${TD} truncate text-muted-foreground`}>
              {x.site ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </Shell>
  )
}

export function RecentIps({ rows }: { rows: DashRecentIp[] }) {
  if (!rows.length) return <Empty />
  return (
    <Shell>
      <thead className="sticky top-0 bg-card">
        <tr>
          <th className={TH}>Address</th>
          <th className={TH}>Status</th>
          <th className={TH}>DNS name</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">
        {rows.map((x) => (
          <tr key={x.id} className="hover:bg-muted/40">
            <td className={TD}>
              <Link
                to="/ips/$id"
                params={{ id: x.id }}
                className="font-mono font-medium hover:underline"
              >
                {x.ip}
              </Link>
            </td>
            <td className={TD}>
              {x.status ? (
                <ColorBadge
                  name={x.status}
                  color={x.status_color || undefined}
                />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td
              className={`${TD} truncate font-mono text-[12px] text-muted-foreground`}
            >
              {x.dns ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </Shell>
  )
}

function Empty() {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
      Nothing yet.
    </div>
  )
}
