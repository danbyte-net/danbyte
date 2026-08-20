import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type Paginated,
  type VMInterface,
  type VirtNetwork,
} from "@/lib/api"
import { railText } from "@/routes/virtual-topology.index"

// Mirrors the main topology view's language at VM scale: the VM box on top,
// its networks as solid coloured rails below, one coloured leg per attachment.
const W = 780
const PAD = 8
const VM_W = 150
const VM_H = 44
const RAIL_H = 30
const RAIL_GAP = 22 // room for the interface label sitting above each rail
const DROP = 26 // space between the box and the first rail

// Shades of the Danbyte blue - zone colours (firewall semantics) override.
const PALETTE = [
  "#1d63ed",
  "#0ea5e9",
  "#1e40af",
  "#38bdf8",
  "#2563eb",
  "#0369a1",
  "#60a5fa",
  "#075985",
]

function fit(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** VM-centric slice of the network topology: this VM's interfaces → the
 * networks (VLANs) they're on → the virtual switch each rides. Multi-homing
 * shows one rail per network, in the same style as the topology page. */
type Conn = {
  key: string
  ifaceName: string
  vlan: { id: string; vlan_id: number; name: string; color?: string | null } | null
  net: VirtNetwork | null
}

export function VmTopologyCard({
  vmId,
  vmName,
  syncedFromId,
}: {
  vmId: string
  vmName?: string
  /** The tracking virtualization source, when synced - drives the empty-state
   * copy so it never tells the user to enable something already on. */
  syncedFromId?: string | null
}) {
  const nav = useNavigate()
  const ifaces = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  // The sync's direct NIC-to-network links. This is the primary source:
  // vCenter never states a VLAN on a NIC, so inferring through VLANs left
  // every vCenter VM looking unmapped (#46).
  const nets = useQuery({
    queryKey: ["virt-networks", "vm", vmId],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(`/api/virt-networks/?vm=${vmId}`),
  })
  const source = useQuery({
    queryKey: ["virt-source", syncedFromId],
    queryFn: () =>
      api<{ sync_networks: boolean; name: string }>(
        `/api/virtualization-sources/${syncedFromId}/`
      ),
    enabled: !!syncedFromId,
  })

  const conns: Conn[] = []
  const seen = new Set<string>()
  for (const net of nets.data?.results ?? []) {
    for (const v of net.vms ?? []) {
      if (v.id !== vmId) continue
      const ifaceName = v.iface ?? ""
      const k = `${net.id}:${ifaceName}`
      if (seen.has(k)) continue
      seen.add(k)
      conns.push({ key: k, ifaceName, vlan: net.vlan ?? null, net })
    }
  }
  // Operator-modelled interfaces with a VLAN but no sync link still render.
  for (const i of ifaces.data?.results ?? []) {
    if (!i.vlan) continue
    if (conns.some((c) => c.ifaceName === i.name)) continue
    conns.push({
      key: `vlan:${i.id}`,
      ifaceName: i.name,
      vlan: i.vlan,
      net: null,
    })
  }

  if (ifaces.isLoading || nets.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (conns.length === 0) {
    const syncOn = source.data?.sync_networks
    return (
      <p className="text-sm text-muted-foreground">
        {syncOn ? (
          <>
            The source syncs networks, but hasn&rsquo;t linked this
            VM&rsquo;s interfaces to one yet. Run a sync - and note vCenter
            network links need Danbyte v0.13.0 or newer.
          </>
        ) : syncedFromId ? (
          <>
            This VM isn&rsquo;t on a mapped virtual network yet. Enable{" "}
            <span className="font-medium">
              virtual switches &amp; networks
            </span>{" "}
            sync on its source to populate this.
          </>
        ) : (
          <>
            No virtual networks are mapped for this VM. Networks appear here
            when a virtualization source syncs them, or when an interface is
            assigned a VLAN.
          </>
        )}
      </p>
    )
  }

  const vmCx = PAD + VM_W / 2
  const railsY = (i: number) => PAD + VM_H + DROP + i * (RAIL_H + RAIL_GAP)
  const height = railsY(conns.length - 1) + RAIL_H + PAD
  const colorFor = (i: number) =>
    conns[i].vlan?.color || PALETTE[i % PALETTE.length]

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Network topology
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
        <svg width={W} height={height} style={{ fontFamily: "inherit" }}>
          {/* legs - ribbon-cable lanes: each attachment runs box → its rail in
              its own parallel lane, labelled above the rail it plugs into */}
          {conns.map((c, i) => {
            const color = colorFor(i)
            const lx = vmCx + (i - (conns.length - 1) / 2) * 8
            return (
              <line
                key={c.key}
                x1={lx}
                y1={PAD + VM_H}
                x2={lx}
                y2={railsY(i) + RAIL_H / 2}
                stroke={color}
                strokeWidth={3}
                strokeLinecap="round"
              />
            )
          })}

          {/* interface labels - drawn after the lanes and placed clear of the
              whole ribbon, so a lane never crosses its own or another label */}
          {conns.map((c, i) => (
            <text
              key={`lbl-${c.key}`}
              x={vmCx + ((conns.length - 1) / 2) * 8 + 10}
              y={railsY(i) - 5}
              fontSize={10}
              className="font-mono"
              fill="var(--muted-foreground)"
            >
              {c.ifaceName}
            </text>
          ))}

          {/* the VM */}
          <rect
            x={PAD}
            y={PAD}
            width={VM_W}
            height={VM_H}
            rx={8}
            fill="var(--card)"
            stroke="var(--border)"
          />
          <text
            x={vmCx}
            y={PAD + VM_H / 2 + 4}
            fontSize={12}
            fontWeight={600}
            textAnchor="middle"
            fill="var(--foreground)"
          >
            {fit(vmName ?? "This VM", 18)}
          </text>

          {/* network rails */}
          {conns.map((c, i) => {
            const color = colorFor(i)
            const y = railsY(i)
            const label =
              (c.net?.name || c.vlan?.name || c.net?.ext_key || "network") +
              (c.vlan ? `  ·  VLAN ${c.vlan.vlan_id}` : "")
            const vlanId = c.vlan?.id
            return (
              <g
                key={`rail-${c.key}`}
                className={vlanId ? "cursor-pointer" : undefined}
                onClick={
                  vlanId
                    ? () => nav({ to: "/vlans/$id", params: { id: vlanId } })
                    : undefined
                }
              >
                <rect
                  x={PAD}
                  y={y}
                  width={W - 2 * PAD}
                  height={RAIL_H}
                  rx={6}
                  fill={color}
                  fillOpacity={1}
                />
                <text
                  x={PAD + 12}
                  y={y + RAIL_H / 2 + 4}
                  fontSize={12}
                  fontWeight={600}
                  fill={railText(color)}
                >
                  {fit(label, 40)}
                </text>
                {c.net?.vswitch_name && (
                  <text
                    x={W - PAD - 12}
                    y={y + RAIL_H / 2 + 4}
                    fontSize={10}
                    textAnchor="end"
                    fill={railText(color)}
                    opacity={0.85}
                  >
                    {fit(c.net.vswitch_name, 28)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}
