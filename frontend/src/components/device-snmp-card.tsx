import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import type { DeviceSnmp, IPAddress, Interface } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { KvCard, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { SnmpBindingControl } from "@/components/snmp-binding-control"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

// Friendly labels for the system-group OIDs we poll. Anything unmapped falls
// back to the raw key.
const FACT_LABELS: Record<string, string> = {
  sys_name: "Name",
  sys_descr: "Description",
  sys_object_id: "Object ID",
  sys_uptime: "Uptime",
  sys_contact: "Contact",
  sys_location: "Location",
}
const FACT_ORDER = [
  "sys_name",
  "sys_descr",
  "sys_object_id",
  "sys_uptime",
  "sys_contact",
  "sys_location",
]

interface ListResp<T> {
  count: number
  results: T[]
}

/**
 * Read-only **observed** SNMP facts for a device (issue #84, Phase 1). Polling
 * never touches the device's source-of-truth fields — it only refreshes this
 * card. Gated to users who can change the device.
 *
 * Every observed value that corresponds to an object Danbyte already records
 * (interface, VLAN, IP, MAC) links to that object's detail page — NetBox-style
 * — so the tab is a jumping-off point, not a dead end. The lookups resolve
 * client-side from the device's own interfaces/IPs (shared query cache), so
 * there's no extra backend work: things SNMP sees but Danbyte lacks stay plain
 * text (import them from the Drift inbox or "Sync from SNMP").
 */
export function DeviceSnmpCard({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canPoll = canDo("device", "change")

  const snmp = useQuery({
    queryKey: ["device-snmp", deviceId],
    queryFn: () => api<DeviceSnmp>(`/api/monitoring/devices/${deviceId}/snmp/`),
  })
  const util = useQuery({
    queryKey: ["device-snmp-util", deviceId],
    queryFn: () =>
      api<{
        interfaces: Record<
          string,
          { in_pct: number | null; out_pct: number | null }[]
        >
      }>(`/api/monitoring/devices/${deviceId}/snmp/utilization/`),
  })

  // Danbyte's own view of this device — shared cache with the IPs/Interfaces
  // tabs — so we can turn observed strings into links to real objects.
  const ipsQ = useQuery({
    queryKey: ["device-ips", deviceId],
    queryFn: () => api<ListResp<IPAddress>>(`/api/devices/${deviceId}/ips/`),
  })
  const ifsQ = useQuery({
    queryKey: ["device-interfaces", deviceId],
    queryFn: () =>
      api<ListResp<Interface>>(`/api/devices/${deviceId}/interfaces/`),
  })
  const ipIdByAddr = useMemo(() => {
    const m = new Map<string, string>()
    for (const ip of ipsQ.data?.results ?? []) m.set(ip.ip_address, ip.id)
    return m
  }, [ipsQ.data])
  const ifaceIdByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of ifsQ.data?.results ?? []) m.set(i.name.toLowerCase(), i.id)
    return m
  }, [ifsQ.data])
  const vlanIdByVid = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of ifsQ.data?.results ?? [])
      if (i.vlan) m.set(String(i.vlan.vlan_id), i.vlan.id)
    return m
  }, [ifsQ.data])

  const poll = useMutation({
    // No profile_id — the backend resolves it along the hierarchy
    // (device → role → type → tenant default).
    mutationFn: () =>
      api<DeviceSnmp>(`/api/monitoring/devices/${deviceId}/snmp-poll/`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["device-snmp", deviceId], data)
      qc.invalidateQueries({ queryKey: ["device-snmp-util", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-snmp-drift", deviceId] })
      if (data.reachable) toast.success("Polled device over SNMP")
      else toast.error(data.error || "Device did not respond to SNMP")
    },
    onError: (e) => apiErrorToast(e),
  })

  const state = snmp.data
  const facts = state?.data ?? {}
  const factKeys = [
    ...FACT_ORDER.filter((k) => facts[k]),
    ...Object.keys(facts).filter((k) => !FACT_ORDER.includes(k)),
  ]
  const factRows: KvRow[] = factKeys.map((k) => ({
    label: FACT_LABELS[k] ?? k,
    value: mono(facts[k]),
    copy: facts[k],
  }))

  const ifColumns: SimpleColumn<DeviceSnmp["interfaces"][number]>[] = [
    {
      id: "name",
      header: "Name",
      cell: (i) => (
        <IfaceLink name={i.name} id={ifaceIdByName.get(i.name.toLowerCase())} />
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (i) => <IfStatus admin={i.admin_status} oper={i.oper_status} />,
    },
    {
      id: "layer",
      header: "Layer",
      cell: (i) =>
        i.layer ? <Badge variant="secondary">{i.layer}</Badge> : <Muted />,
    },
    {
      id: "vlan",
      header: "VLAN",
      cell: (i) => (
        <VlanLink
          vid={i.vlan}
          name={i.vlan_name}
          id={vlanIdByVid.get(String(i.vlan))}
        />
      ),
    },
    {
      id: "speed",
      header: "Speed",
      cell: (i) => <span className="font-mono">{fmtSpeed(i.speed_mbps)}</span>,
    },
    {
      id: "util",
      header: "Util (in)",
      cell: (i) => {
        // The Record index is undefined at runtime for an interface with no
        // counter samples yet — the `?? []` keeps UtilCell from mapping over it.
        const series = util.data?.interfaces[i.if_index] ?? []
        return <UtilCell series={series} />
      },
    },
    { id: "mac", header: "MAC", cell: (i) => <MacLink mac={i.mac} /> },
    {
      id: "ips",
      header: "IP addresses",
      cell: (i) => <IpLinks ips={i.ip_addresses} idByAddr={ipIdByAddr} />,
    },
    {
      id: "descr",
      header: "Description",
      flex: true,
      cell: (i) => (
        <span
          className="text-muted-foreground"
          title={i.alias || i.descr || i.type_name}
        >
          {i.alias || i.descr || i.type_name || "—"}
        </span>
      ),
    },
  ]

  const nbColumns: SimpleColumn<DeviceSnmp["neighbors"][number]>[] = [
    {
      id: "local",
      header: "Local port",
      cell: (n) => (
        <IfaceLink
          name={n.local_port}
          id={ifaceIdByName.get(n.local_port.toLowerCase())}
        />
      ),
    },
    {
      id: "neighbour",
      header: "Neighbour",
      cell: (n) => (
        <span className="font-mono font-medium">{n.remote_device}</span>
      ),
    },
    {
      id: "remote",
      header: "Remote port",
      flex: true,
      cell: (n) => (
        <span className="font-mono text-muted-foreground">
          {n.remote_port || "—"}
        </span>
      ),
    },
  ]

  const arpColumns: SimpleColumn<DeviceSnmp["arp"][number]>[] = [
    {
      id: "ip",
      header: "IP address",
      cell: (a) => <IpLinks ips={[a.ip]} idByAddr={ipIdByAddr} />,
    },
    { id: "mac", header: "MAC", cell: (a) => <MacLink mac={a.mac} /> },
    {
      id: "if",
      header: "Interface",
      flex: true,
      cell: (a) => (
        <span className="font-mono text-muted-foreground">
          {a.if_index || "—"}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {/* Observed header: reachability + the credential binding + Poll now. */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Observed
        </h2>
        {state?.reachable === true && (
          <Badge variant="success">reachable</Badge>
        )}
        {state?.reachable === false && (
          <Badge variant="destructive">unreachable</Badge>
        )}
        <div className="ml-auto flex items-center gap-3">
          <SnmpBindingControl
            scope="device"
            objectId={deviceId}
            canEdit={canPoll}
          />
          {canPoll && (
            <Button
              size="sm"
              variant="outline"
              disabled={poll.isPending}
              onClick={() => poll.mutate()}
            >
              <RefreshCw
                className={
                  "h-3.5 w-3.5 " + (poll.isPending ? "animate-spin" : "")
                }
              />
              Poll now
            </Button>
          )}
        </div>
      </div>

      {factRows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {state?.error
            ? state.error
            : "Not polled yet — pick a profile and use “Poll now” to read the device's live system facts."}
        </p>
      ) : (
        <KvCard title="System" rows={factRows} />
      )}

      {state && state.interfaces.length > 0 && (
        <Section title="Interfaces" count={state.interfaces.length}>
          <SimpleTable
            columns={ifColumns}
            data={state.interfaces}
            getRowKey={(i) => i.if_index}
          />
        </Section>
      )}

      {state && state.neighbors.length > 0 && (
        <Section title="LLDP neighbours" count={state.neighbors.length}>
          <SimpleTable
            columns={nbColumns}
            data={state.neighbors}
            getRowKey={(_n, i) => i}
          />
        </Section>
      )}

      {state && state.arp.length > 0 && (
        <Section title="ARP table" count={state.arp.length}>
          <SimpleTable
            columns={arpColumns}
            data={state.arp}
            getRowKey={(_a, i) => i}
          />
        </Section>
      )}

      {state?.polled_at && (
        <p className="text-[11px] text-muted-foreground">
          Last polled{" "}
          <span className="num">
            {new Date(state.polled_at).toLocaleString()}
          </span>
          {state.profile_name ? ` · ${state.profile_name}` : ""}
        </p>
      )}
    </div>
  )
}

function Muted() {
  return <span className="text-muted-foreground">—</span>
}

function fmtSpeed(mbps: string): string {
  const n = Number(mbps)
  if (!n) return "—"
  return n >= 1000 ? `${n / 1000} Gbps` : `${n} Mbps`
}

/** An interface name that links to its detail page when Danbyte records it. */
function IfaceLink({ name, id }: { name: string; id?: string }) {
  if (!name) return <Muted />
  if (!id) return <span className="font-mono">{name}</span>
  return (
    <Link
      to="/interfaces/$id"
      params={{ id }}
      className="font-mono text-primary hover:underline"
    >
      {name}
    </Link>
  )
}

/** A VLAN (id · name) that links to its detail page when Danbyte records it. */
function VlanLink({
  vid,
  name,
  id,
}: {
  vid: string
  name: string
  id?: string
}) {
  if (!vid) return <Muted />
  const label = name ? `${vid} · ${name}` : vid
  if (!id) return <span className="font-mono">{label}</span>
  return (
    <Link
      to="/vlans/$id"
      params={{ id }}
      className="font-mono text-primary hover:underline"
    >
      {label}
    </Link>
  )
}

/** Observed IPs — each links to its IP detail page when Danbyte records it. */
function IpLinks({
  ips,
  idByAddr,
}: {
  ips: string[]
  idByAddr: Map<string, string>
}) {
  if (ips.length === 0) return <Muted />
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {ips.map((ip) => {
        const id = idByAddr.get(ip)
        return id ? (
          <Link
            key={ip}
            to="/ips/$id"
            params={{ id }}
            className="font-mono text-primary hover:underline"
          >
            {ip}
          </Link>
        ) : (
          <span key={ip} className="font-mono">
            {ip}
          </span>
        )
      })}
    </div>
  )
}

/** A MAC that links to its `/macs/<mac>` object page, or "—" when absent. */
function MacLink({ mac }: { mac: string }) {
  if (!mac) return <Muted />
  return (
    <Link
      to="/macs/$mac"
      params={{ mac }}
      className="font-mono text-primary hover:underline"
    >
      {mac}
    </Link>
  )
}

/** A tiny inbound-utilisation sparkline + latest %, from the counter series. */
function UtilCell({
  series,
}: {
  series: { in_pct: number | null; out_pct: number | null }[]
}) {
  const vals = series.map((p) => p.in_pct ?? 0)
  if (vals.length === 0) return <Muted />
  const latest = vals[vals.length - 1]
  const W = 48
  const H = 14
  // Fixed 0–100% scale so heights are comparable across interfaces.
  const points = vals
    .map((v, i) => {
      const x = vals.length === 1 ? W : (i / (vals.length - 1)) * W
      const y = H - (Math.min(100, Math.max(0, v)) / 100) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={W} height={H} className="text-primary">
        {vals.length > 1 && (
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          />
        )}
      </svg>
      <span className="num text-[11px] text-muted-foreground">
        {latest.toFixed(0)}%
      </span>
    </span>
  )
}

/** Oper status drives the colour; admin-down is shown muted regardless. */
function IfStatus({ admin, oper }: { admin: string; oper: string }) {
  if (admin === "down") return <Badge variant="secondary">admin-down</Badge>
  const variant =
    oper === "up"
      ? "success"
      : oper === "down" || oper === "lowerLayerDown"
        ? "destructive"
        : "warning"
  return <Badge variant={variant}>{oper || "—"}</Badge>
}
