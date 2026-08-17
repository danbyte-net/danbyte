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
const SW_Y = 92
const SW_H = 46
const SW_W = 190
const NET_Y = 196
const NET_H = 34
const VM_Y = 278
const VM_W = 132
const VM_H = 50
const VM_GAP = 16
const NET_GAP = 44
const SW_GAP = 72
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
  switches: {
    id: string
    cx: number
    name: string
    kind: string
    uplinks: string[]
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
  const networks: Laid["networks"] = []
  const vms: Laid["vms"] = []
  const edges: Laid["edges"] = []

  let x = PAD
  const swMidY = (SW_Y + SW_H + NET_Y) / 2

  for (const [swId, nets] of groups) {
    const sw = swById.get(swId)
    const swStart = x

    for (const net of nets) {
      const list = net.vms
      const rowW =
        list.length > 0
          ? list.length * VM_W + (list.length - 1) * VM_GAP
          : NET_MIN_W
      const netX = x
      const netCx = netX + rowW / 2
      networks.push({
        id: net.id,
        x: netX,
        w: rowW,
        cx: netCx,
        label: net.name || net.ext_key,
        vlan: net.vlan,
      })
      list.forEach((vm, i) => {
        const vmX = netX + i * (VM_W + VM_GAP)
        const vmCx = vmX + VM_W / 2
        vms.push({
          key: `${net.id}:${vm.id}`,
          id: vm.id,
          cx: vmCx,
          name: vm.name,
          status: vm.status,
        })
        // network bar → VM (straight drop)
        edges.push({
          key: `nv-${net.id}-${vm.id}`,
          d: `M ${vmCx} ${NET_Y + NET_H} L ${vmCx} ${VM_Y}`,
        })
      })
      x += rowW + NET_GAP
    }

    const swEnd = x - NET_GAP
    const swCx = nets.length ? (swStart + swEnd) / 2 : swStart + SW_W / 2
    switches.push({
      id: swId,
      cx: swCx,
      name: sw?.name ?? "switch",
      kind: sw?.kind_display ?? "",
      uplinks: (sw?.uplink_interfaces ?? []).map(
        (u) => `${u.device.name}/${u.name}`
      ),
    })
    // external → switch
    edges.push({
      key: `es-${swId}`,
      d: `M ${swCx} ${EXT_Y + EXT_H} L ${swCx} ${SW_Y}`,
    })
    // switch → each of its networks (orthogonal)
    for (const net of nets) {
      const n = networks.find((nn) => nn.id === net.id)!
      edges.push({
        key: `sn-${swId}-${net.id}`,
        d: `M ${swCx} ${SW_Y + SW_H} L ${swCx} ${swMidY} L ${n.cx} ${swMidY} L ${n.cx} ${NET_Y}`,
      })
    }
    x += SW_GAP - NET_GAP
  }

  const width = Math.max(x + PAD, 640)
  const height = VM_Y + VM_H + PAD
  return { width, height, switches, networks, vms, edges }
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
                  {s.uplinks.length
                    ? `uplinks: ${fit(s.uplinks.join(", "), 26)}`
                    : s.kind}
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
        External → switches → networks (VLANs) → VMs. Click any node to open it.
      </div>
    </ListPageShell>
  )
}
