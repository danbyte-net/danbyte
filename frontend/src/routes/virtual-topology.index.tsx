import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Cloud } from "lucide-react"

import {
  api,
  type Paginated,
  type VirtNetwork,
  type VirtualizationSource,
  type VirtualSwitch,
} from "@/lib/api"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/virtual-topology/")({
  component: VirtualTopologyPage,
})

// ─── layout geometry ─────────────────────────────────────────────────────────
const PAD = 32
const EXT_Y = 12
const EXT_H = 30
const ADP_Y = 78
const ADP_H = 46
const ADP_W = 120
const ADP_GAP = 14
const SW_Y = 184
const SW_H = 46
const SW_W = 190
const NET_Y = 288
const NET_H = 34
const VM_Y = 366
const VM_W = 132
const VM_H = 50
const VM_GAP = 16
const NET_GAP = 44
const SW_GAP = 80
const NET_MIN_W = 150

function vmColors(status: string | null): { stroke: string; fill: string } {
  const s = (status || "").toLowerCase()
  if (/(active|running|up|online|powered.?on)/.test(s))
    return { stroke: "#10b981", fill: "rgba(16,185,129,0.08)" }
  if (/(off|down|decom|failed|stopped|suspend)/.test(s))
    return { stroke: "#ef4444", fill: "rgba(239,68,68,0.08)" }
  return { stroke: "var(--border)", fill: "var(--muted)" }
}

/** Truncate to fit a node width (SVG text doesn't wrap). */
function fit(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

interface Laid {
  width: number
  height: number
  switches: { id: string; cx: number; name: string; kind: string }[]
  adapters: {
    key: string
    ifaceId: string
    cx: number
    nic: string
    host: string
  }[]
  networks: {
    id: string
    x: number
    w: number
    cx: number
    label: string
    vlan: { id: string; vlan_id: number } | null
  }[]
  vms: {
    key: string
    id: string
    cx: number
    name: string
    status: string | null
  }[]
  edges: { key: string; d: string }[]
}

function layout(
  groups: [string, VirtNetwork[]][],
  swById: Map<string, VirtualSwitch>
): Laid {
  const switches: Laid["switches"] = []
  const adapters: Laid["adapters"] = []
  const networks: Laid["networks"] = []
  const vms: Laid["vms"] = []
  const edges: Laid["edges"] = []

  const swMidY = (SW_Y + SW_H + NET_Y) / 2
  const adpMidY = (ADP_Y + ADP_H + SW_Y) / 2

  const netW = (n: VirtNetwork) =>
    n.vms.length > 0
      ? n.vms.length * VM_W + (n.vms.length - 1) * VM_GAP
      : NET_MIN_W

  let x = PAD
  for (const [swId, nets] of groups) {
    const sw = swById.get(swId)
    const ups = sw?.uplink_interfaces ?? []

    // Reserve a column wide enough for whichever is wider: the VM rows or the
    // physical-adapter row (many hypervisors on one switch never overlap).
    const netsTotal =
      nets.reduce((a, n) => a + netW(n), 0) +
      Math.max(0, nets.length - 1) * NET_GAP
    const adpTotal =
      ups.length > 0 ? ups.length * (ADP_W + ADP_GAP) - ADP_GAP : 0
    const groupW = Math.max(netsTotal, adpTotal, SW_W)
    const center = x + groupW / 2

    // networks + their VMs, centred in the column
    let nx = center - netsTotal / 2
    for (const net of nets) {
      const w = netW(net)
      const netCx = nx + w / 2
      networks.push({
        id: net.id,
        x: nx,
        w,
        cx: netCx,
        label: net.name || net.ext_key,
        vlan: net.vlan,
      })
      net.vms.forEach((vm, i) => {
        const vmCx = nx + i * (VM_W + VM_GAP) + VM_W / 2
        vms.push({
          key: `${net.id}:${vm.id}`,
          id: vm.id,
          cx: vmCx,
          name: vm.name,
          status: vm.status,
        })
        edges.push({
          key: `nv-${net.id}-${vm.id}`,
          d: `M ${vmCx} ${NET_Y + NET_H} L ${vmCx} ${VM_Y}`,
        })
      })
      edges.push({
        key: `sn-${swId}-${net.id}`,
        d: `M ${center} ${SW_Y + SW_H} L ${center} ${swMidY} L ${netCx} ${swMidY} L ${netCx} ${NET_Y}`,
      })
      nx += w + NET_GAP
    }

    // physical adapters (host NICs) feeding the switch, centred above it
    let ax = center - adpTotal / 2
    ups.forEach((u) => {
      const adpCx = ax + ADP_W / 2
      adapters.push({
        key: `${swId}:${u.id}`,
        ifaceId: u.id,
        cx: adpCx,
        nic: u.name,
        host: u.device.name,
      })
      edges.push({
        key: `ea-${swId}-${u.id}`,
        d: `M ${adpCx} ${EXT_Y + EXT_H} L ${adpCx} ${ADP_Y}`,
      })
      edges.push({
        key: `as-${swId}-${u.id}`,
        d: `M ${adpCx} ${ADP_Y + ADP_H} L ${adpCx} ${adpMidY} L ${center} ${adpMidY} L ${center} ${SW_Y}`,
      })
      ax += ADP_W + ADP_GAP
    })
    if (ups.length === 0)
      edges.push({
        key: `es-${swId}`,
        d: `M ${center} ${EXT_Y + EXT_H} L ${center} ${SW_Y}`,
      })

    switches.push({
      id: swId,
      cx: center,
      name: sw?.name ?? "switch",
      kind: sw?.kind_display ?? "",
    })
    x += groupW + SW_GAP
  }

  const width = Math.max(x - SW_GAP + PAD, 640)
  const height = VM_Y + VM_H + PAD
  return { width, height, switches, adapters, networks, vms, edges }
}

function VirtualTopologyPage() {
  const [source, setSource] = useState("")
  const nav = useNavigate()

  const sources = useQuery({
    queryKey: ["virtualization-sources", "topology"],
    queryFn: () =>
      api<Paginated<VirtualizationSource>>("/api/virtualization-sources/"),
  })
  const switches = useQuery({
    queryKey: ["virtual-switches", "topology"],
    queryFn: () => api<Paginated<VirtualSwitch>>("/api/virtual-switches/"),
  })
  const networks = useQuery({
    queryKey: ["virt-networks", "topology", source],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(
        `/api/virt-networks/?${new URLSearchParams(source ? { source } : {})}`
      ),
  })

  const swById = useMemo(() => {
    const m = new Map<string, VirtualSwitch>()
    for (const s of switches.data?.results ?? []) m.set(s.id, s)
    return m
  }, [switches.data])

  const groups = useMemo(() => {
    const by = new Map<string, VirtNetwork[]>()
    for (const n of networks.data?.results ?? []) {
      const k = n.vswitch ?? "—"
      const l = by.get(k)
      if (l) l.push(n)
      else by.set(k, [n])
    }
    return [...by.entries()]
  }, [networks.data])

  const laid = useMemo(() => layout(groups, swById), [groups, swById])
  const loading = networks.isLoading || switches.isLoading
  const isEmpty = !loading && groups.length === 0

  return (
    <ListPageShell
      title="Virtual network topology"
      query={networks}
      actions={
        <Select
          value={source || "all"}
          onValueChange={(v) => setSource(v === "all" ? "" : v)}
        >
          <SelectTrigger size="sm" className="h-8 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {(sources.data?.results ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {isEmpty ? (
        <EmptyState title="No virtual networks to map yet.">
          Turn on{" "}
          <span className="font-medium">
            Sync virtual switches &amp; networks
          </span>{" "}
          on a virtualization source and re-sync — its switches, networks
          (VLANs) and the VMs on them are drawn here.
        </EmptyState>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
          <svg
            width={laid.width}
            height={laid.height}
            className="min-w-full"
            style={{ fontFamily: "inherit" }}
          >
            {/* connectors first (behind nodes) */}
            {laid.edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
              />
            ))}

            {/* external network bar */}
            <rect
              x={PAD}
              y={EXT_Y}
              width={laid.width - 2 * PAD}
              height={EXT_H}
              rx={6}
              fill="var(--muted)"
              stroke="var(--border)"
            />
            <text
              x={PAD + 12}
              y={EXT_Y + EXT_H / 2 + 4}
              fontSize={12}
              fontWeight={600}
              fill="var(--muted-foreground)"
            >
              External network
            </text>

            {/* physical adapters — host NICs feeding a switch (many hosts ok) */}
            {laid.adapters.map((a) => (
              <g
                key={a.key}
                className="cursor-pointer"
                onClick={() =>
                  nav({
                    to: "/interfaces/$id",
                    params: { id: a.ifaceId },
                  })
                }
              >
                <rect
                  x={a.cx - ADP_W / 2}
                  y={ADP_Y}
                  width={ADP_W}
                  height={ADP_H}
                  rx={6}
                  fill="var(--muted)"
                  stroke="var(--border)"
                />
                <text
                  x={a.cx}
                  y={ADP_Y + 19}
                  fontSize={12}
                  fontWeight={600}
                  textAnchor="middle"
                  fill="var(--foreground)"
                  className="font-mono"
                >
                  {fit(a.nic, 14)}
                </text>
                <text
                  x={a.cx}
                  y={ADP_Y + 35}
                  fontSize={10}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                >
                  {fit(a.host, 16)}
                </text>
              </g>
            ))}

            {/* switches */}
            {laid.switches.map((s) => (
              <g
                key={s.id}
                className="cursor-pointer"
                onClick={() =>
                  nav({ to: "/virtual-switches/$id", params: { id: s.id } })
                }
              >
                <rect
                  x={s.cx - SW_W / 2}
                  y={SW_Y}
                  width={SW_W}
                  height={SW_H}
                  rx={8}
                  fill="var(--card)"
                  stroke="var(--border)"
                />
                <text
                  x={s.cx}
                  y={SW_Y + 19}
                  fontSize={13}
                  fontWeight={600}
                  textAnchor="middle"
                  fill="var(--foreground)"
                >
                  {fit(s.name, 24)}
                </text>
                <text
                  x={s.cx}
                  y={SW_Y + 35}
                  fontSize={10}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                >
                  {s.kind}
                </text>
              </g>
            ))}

            {/* network (VLAN) bars */}
            {laid.networks.map((n) => (
              <g
                key={n.id}
                className={n.vlan ? "cursor-pointer" : undefined}
                onClick={() =>
                  n.vlan && nav({ to: "/vlans/$id", params: { id: n.vlan.id } })
                }
              >
                <rect
                  x={n.x}
                  y={NET_Y}
                  width={n.w}
                  height={NET_H}
                  rx={6}
                  fill="var(--primary)"
                  fillOpacity={0.1}
                  stroke="var(--primary)"
                  strokeOpacity={0.4}
                />
                <text
                  x={n.x + 10}
                  y={NET_Y + NET_H / 2 + 4}
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--foreground)"
                >
                  {fit(n.label, Math.max(6, Math.floor(n.w / 8)))}
                  {n.vlan ? (
                    <tspan fill="var(--muted-foreground)" fontWeight={400}>
                      {"  · VLAN "}
                      {n.vlan.vlan_id}
                    </tspan>
                  ) : null}
                </text>
              </g>
            ))}

            {/* VM boxes */}
            {laid.vms.map((vm) => {
              const c = vmColors(vm.status)
              return (
                <g
                  key={vm.key}
                  className="cursor-pointer"
                  onClick={() =>
                    nav({
                      to: "/virtual-machines/$id",
                      params: { id: vm.id },
                    })
                  }
                >
                  <rect
                    x={vm.cx - VM_W / 2}
                    y={VM_Y}
                    width={VM_W}
                    height={VM_H}
                    rx={8}
                    fill={c.fill}
                    stroke={c.stroke}
                  />
                  <text
                    x={vm.cx}
                    y={VM_Y + 21}
                    fontSize={12}
                    fontWeight={600}
                    textAnchor="middle"
                    fill="var(--foreground)"
                  >
                    {fit(vm.name, 16)}
                  </text>
                  <text
                    x={vm.cx}
                    y={VM_Y + 37}
                    fontSize={10}
                    textAnchor="middle"
                    fill="var(--muted-foreground)"
                  >
                    {vm.status || "—"}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Cloud className="h-3.5 w-3.5" />
        External → physical adapters (host NICs) → switches → networks (VLANs) →
        VMs. Click any node to open it.
      </div>
    </ListPageShell>
  )
}
