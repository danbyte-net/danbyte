import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Copy,
  CopyPlus,
  Pencil,
  Play,
  Table as TableIcon,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ViolationBadge } from "@/components/compliance/violation-badge"

import { api, type IPAddress } from "@/lib/api"
import { parseCidr, bigIntToIp } from "@/lib/prefix-tree"
import { copyText } from "@/lib/clipboard"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { KvCard, type KvRow } from "@/components/kv-card"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { CatalogCell } from "@/components/cells/catalog-cell"
import { DeviceCell } from "@/components/cells/device-cell"
import { VrfCell } from "@/components/cells/vrf-cell"
import { RoleChip } from "@/components/role-chip"
import { IpDeleteDialog } from "@/components/ip-delete-dialog"
import { IpMonitoring } from "@/components/monitoring/ip-monitoring"
import { IpMonitoringSummary } from "@/components/monitoring/ip-monitoring-summary"
import { QueryError } from "@/components/query-error"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { useMe, objCan } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/ips/$id")({ component: IPDetail })

function IPDetail() {
  const { id } = Route.useParams()
  const query = useQuery({
    queryKey: ["ip", id],
    queryFn: () => api<IPAddress>(`/api/ips/${id}/`),
  })

  if (query.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (query.isError)
    return (
      <div className="p-6">
        <QueryError error={query.error} />
      </div>
    )
  if (!query.data) return null
  return <IPDetailBody ip={query.data} />
}

function IPDetailBody({ ip }: { ip: IPAddress }) {
  const [deleteOpen, setDeleteOpen] = useState<IPAddress | null>(null)
  const [tab, setTab] = useUrlTab<
    "overview" | "monitoring" | "journal" | "history"
  >("overview")
  const qc = useQueryClient()
  const { canDo, humanIds } = useMe()

  // Header "Check now" — runs every check on this IP and refreshes the
  // monitoring summary + tab. Reuses the same endpoint as the Monitoring tab.
  const checkNow = useMutation({
    mutationFn: () =>
      api<{ count: number; results: { status: string }[] }>(
        `/api/monitoring/ips/${ip.id}/check-now/`,
        { method: "POST" }
      ),
    onSuccess: (data) => {
      const up = data.results.filter((r) => r.status === "up").length
      toast.success(
        data.count === 0
          ? "No checks on this IP yet"
          : `Ran ${data.count} check${data.count === 1 ? "" : "s"} — ${up} up`
      )
      qc.invalidateQueries({ queryKey: ["ip-checks", ip.id] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const family: 4 | 6 = ip.ip_address.includes(":") ? 6 : 4

  // ─── Row collections — single source of truth for table render + copy ─

  const detailsRows: KvRow[] = [
    ...(humanIds && ip.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{ip.numid}</span>,
            copy: `#${ip.numid}`,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Description",
      value: ip.description || <span className="text-muted-foreground">—</span>,
      copy: ip.description,
    },
    {
      label: "Reservation note",
      value: ip.reservation_note || (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.reservation_note,
    },
    {
      label: "Status",
      value: <CatalogCell value={ip.status} />,
      copy: ip.status?.name ?? "",
    },
    {
      label: "Role",
      value: <RoleChip role={ip.role} />,
      copy: ip.role?.name ?? "",
    },
    {
      label: "Device",
      value: ip.assigned_device ? (
        <span className="inline-flex items-center gap-2">
          <DeviceCell device={ip.assigned_device} />
          {ip.is_primary_for_device && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              primary
            </Badge>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.assigned_device?.name ?? "",
    },
    {
      label: "Interface",
      value: ip.assigned_interface ? (
        <Link
          to="/interfaces/$id"
          params={{ id: ip.assigned_interface.id }}
          className="font-mono text-primary hover:underline"
        >
          {ip.assigned_interface.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.assigned_interface?.name ?? "",
    },
    {
      label: "MAC address",
      value: ip.mac_address ? (
        <Link
          to="/macs/$mac"
          params={{ mac: ip.mac_address }}
          className="font-mono text-primary hover:underline"
        >
          {ip.mac_address}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.mac_address,
    },
    {
      label: "DNS name",
      value: ip.dns_name ? (
        <span className="font-mono">{ip.dns_name}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.dns_name,
    },
    {
      label: "Last seen",
      value: ip.last_seen ? (
        <TimeCell iso={ip.last_seen} />
      ) : (
        <span className="text-muted-foreground">never</span>
      ),
      copy: ip.last_seen ?? "",
    },
  ]

  const cfEntries = Object.entries(ip.custom_fields ?? {}).filter(
    ([k]) => k && !k.startsWith("_")
  )
  const customFieldRows: KvRow[] = cfEntries.map(([k, v]) => ({
    label: k,
    value: renderCustomValue(v),
    copy: typeof v === "string" ? v : JSON.stringify(v),
  }))

  const networkRows: KvRow[] = [
    {
      label: "Prefix",
      value: ip.prefix ? (
        <Link
          to="/prefixes/$id"
          params={{ id: ip.prefix.id }}
          className="font-mono hover:underline"
        >
          {ip.prefix.cidr}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.prefix?.cidr ?? "",
    },
    {
      label: "VRF",
      value: <VrfCell vrf={ip.prefix?.vrf ?? null} />,
      copy: ip.prefix?.vrf?.name ?? "Global",
    },
    {
      label: "Site",
      value: ip.prefix?.site?.name ?? (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.prefix?.site?.name ?? "",
    },
    {
      label: "VLAN",
      value: ip.prefix?.vlan ? (
        <span className="font-mono">
          {ip.prefix.vlan.vlan_id} · {ip.prefix.vlan.name}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.prefix?.vlan
        ? `${ip.prefix.vlan.vlan_id} ${ip.prefix.vlan.name}`
        : "",
    },
    {
      label: "Gateway",
      value: ip.prefix?.gateway ? (
        <span className="font-mono">{ip.prefix.gateway}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
      copy: ip.prefix?.gateway ?? "",
    },
    {
      label: "Family",
      value: <span className="font-mono">IPv{family}</span>,
      copy: `IPv${family}`,
    },
  ]

  // Minimal subnet info — full breakdown lives on the prefix page.
  const subnetRows: KvRow[] = ip.prefix ? subnetBasics(ip.prefix.cidr) : []

  // ─── Copy actions ─────────────────────────────────────────────────────

  async function copyIp() {
    const ok = await copyText(ip.ip_address)
    if (ok) toast.success(`Copied ${ip.ip_address}`)
    else toast.error("Couldn't copy — clipboard blocked by the browser")
  }

  async function copyAllAsTable() {
    const fmt = (rows: KvRow[]) =>
      rows.map((r) => `${r.label}\t${r.copy ?? ""}`).join("\n")
    const blocks = [
      `IP\t${ip.ip_address}`,
      "",
      fmt(detailsRows),
      "",
      "# Network",
      fmt(networkRows),
    ]
    if (customFieldRows.length > 0) {
      blocks.push("", "# Custom fields", fmt(customFieldRows))
    }
    if (subnetRows.length > 0) {
      blocks.push("", "# Subnet", fmt(subnetRows))
    }
    const ok = await copyText(blocks.join("\n"))
    if (ok) toast.success("Copied IP details to clipboard")
    else toast.error("Couldn't copy — clipboard blocked by the browser")
  }

  return (
    <DetailShell
      backTo="/prefixes"
      backLabel="Prefixes"
      crumbs={
        ip.prefix && (
          <Link
            to="/prefixes/$id"
            params={{ id: ip.prefix.id }}
            className="font-mono hover:text-foreground"
          >
            {ip.prefix.cidr}
          </Link>
        )
      }
      title={<span className="font-mono">{ip.ip_address}</span>}
      presence={{ type: "ipaddress", id: ip.id }}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkNow.mutate()}
            disabled={checkNow.isPending}
          >
            <Play className="h-3.5 w-3.5" />
            {checkNow.isPending ? "Checking…" : "Check now"}
          </Button>
          <Button variant="outline" size="sm" onClick={copyIp}>
            <Copy className="h-3.5 w-3.5" /> Copy IP
          </Button>
          <Button variant="outline" size="sm" onClick={copyAllAsTable}>
            <TableIcon className="h-3.5 w-3.5" /> Copy as table
          </Button>
          {canDo("ipaddress", "add") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ips/new" search={{ clone: ip.id }}>
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </Link>
            </Button>
          )}
          {objCan(ip, "change", canDo("ipaddress", "change")) && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ips/$id/edit" params={{ id: ip.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {objCan(ip, "delete", canDo("ipaddress", "delete")) && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(ip)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        /* Big address + chips + description (emphasis on description because
           that's what operators actually look up). */
        <section className="flex shrink-0 flex-col gap-3 border-b border-border px-6 py-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-mono text-3xl font-semibold tracking-tight">
              {ip.ip_address}
            </h1>
            <ViolationBadge objectId={ip.id} prominent />
            <CatalogCell value={ip.status} />
            <RoleChip
              role={ip.role}
              showVirtualTag
              isVirtual={ip.role?.is_virtual}
            />
            {/* The containing subnet's zone (via its VLAN) — where this IP
                lives, firewall-wise. */}
            {ip.prefix?.vlan?.zone && (
              <ColorBadge
                name={ip.prefix.vlan.zone.name}
                color={ip.prefix.vlan.zone.color || undefined}
              />
            )}
            {ip.tags.length > 0 && <TagList tags={ip.tags} />}
          </div>
          {ip.description && (
            <p className="max-w-prose text-sm leading-relaxed text-foreground">
              {ip.description}
            </p>
          )}
          {ip.reservation_note && (
            <p className="max-w-prose text-xs text-muted-foreground italic">
              <span className="mr-1 text-muted-foreground/80">
                Reservation note —
              </span>
              {ip.reservation_note}
            </p>
          )}
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "monitoring", label: "Monitoring" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="mb-6">
          <IpMonitoringSummary
            ipId={ip.id}
            lastSeen={ip.last_seen}
            onOpenMonitoring={() => setTab("monitoring")}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Details" rows={detailsRows} />
          <KvCard title="Network" rows={networkRows} />
        </div>

        {customFieldRows.length > 0 && (
          <div className="mt-6">
            <KvCard title="Custom fields" rows={customFieldRows} />
          </div>
        )}

        {subnetRows.length > 0 && (
          <div className="mt-6">
            <KvCard title="Subnet" rows={subnetRows} />
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Created</span>
            <TimeCell iso={ip.created_at} />
          </span>
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Updated</span>
            <TimeCell iso={ip.updated_at} />
          </span>
        </div>
      </DetailTab>

      <DetailTab value="monitoring">
        <IpMonitoring
          ip={{
            id: ip.id,
            ip_address: ip.ip_address,
            flap_exclude: ip.flap_exclude,
          }}
        />
      </DetailTab>

      <DetailTab value="journal">
        <JournalPanel objectType="api.ipaddress" objectId={ip.id} />
      </DetailTab>

      <DetailTab value="history">
        <ChangeLogPanel objectType="api.ipaddress" objectId={ip.id} />
      </DetailTab>

      <IpDeleteDialog
        ip={deleteOpen}
        onOpenChange={(o) => !o && setDeleteOpen(null)}
        onDeleted={() => window.history.back()}
      />
    </DetailShell>
  )
}

// ─── Reusable kv-table ─────────────────────────────────────────────────

function renderCustomValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") {
    return <span className="text-muted-foreground">—</span>
  }
  if (typeof v === "boolean") {
    return v ? (
      <Badge variant="secondary">true</Badge>
    ) : (
      <Badge variant="outline">false</Badge>
    )
  }
  if (typeof v === "number") return <span className="num">{v}</span>
  if (typeof v === "string") return v
  // arrays / objects: render as a compact JSON string. Power-users can
  // copy the cell via the row's copy button to get the full JSON.
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {JSON.stringify(v)}
    </span>
  )
}

// ─── Subnet helpers ────────────────────────────────────────────────────

// Tiny subnet decoder (IPv4 or IPv6) for the Network table's "Subnet"
// sub-block. Renders network, range and (v4 only) netmask + broadcast —
// using BigInt math so v6 doesn't overflow. The full breakdown lives on the
// prefix detail page.
function subnetBasics(cidr: string): KvRow[] {
  const c = parseCidr(cidr)
  if (!c) return []
  const ip = (n: bigint) => bigIntToIp(n, c.family)
  const network = c.start
  const broadcast = c.end
  // Usable range: v4 /≤30 trims network+broadcast; v6 /≤126 trims only the
  // network (no broadcast); point-to-point / host prefixes keep everything.
  let first = network
  let last = broadcast
  if (c.family === 4 && c.prefixlen <= 30) {
    first = network + 1n
    last = broadcast - 1n
  } else if (c.family === 6 && c.prefixlen <= 126) {
    first = network + 1n
  }
  const rows: KvRow[] = [
    {
      label: "Network",
      value: <span className="font-mono">{ip(network)}</span>,
      copy: ip(network),
    },
  ]
  if (c.family === 4) {
    const mask =
      c.prefixlen === 0
        ? 0n
        : (((1n << BigInt(c.prefixlen)) - 1n) << BigInt(32 - c.prefixlen)) &
          0xffffffffn
    rows.push({
      label: "Netmask",
      value: <span className="font-mono">{ip(mask)}</span>,
      copy: ip(mask),
    })
  }
  rows.push({
    label: "Usable range",
    value: (
      <span className="font-mono">
        {ip(first)} – {ip(last)}
      </span>
    ),
    copy: `${ip(first)} – ${ip(last)}`,
  })
  if (c.family === 4 && c.prefixlen <= 30) {
    rows.push({
      label: "Broadcast",
      value: <span className="font-mono">{ip(broadcast)}</span>,
      copy: ip(broadcast),
    })
  }
  return rows
}
