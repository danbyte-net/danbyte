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

// Shades of the Danbyte blue — zone colours (firewall semantics) override.
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
export function VmTopologyCard({
  vmId,
  vmName,
}: {
  vmId: string
  vmName?: string
}) {
  const nav = useNavigate()
  const ifaces = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  const nets = useQuery({
    queryKey: ["virt-networks", "all"],
    queryFn: () => api<Paginated<VirtNetwork>>("/api/virt-networks/"),
  })

  const netByVlan = new Map(
    (nets.data?.results ?? []).filter((n) => n.vlan).map((n) => [n.vlan!.id, n])
  )
  const conns = (ifaces.data?.results ?? [])
    .filter((i) => i.vlan)
    .map((i) => ({ iface: i, net: netByVlan.get(i.vlan!.id) ?? null }))

  if (ifaces.isLoading || nets.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (conns.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This VM isn't on a mapped virtual network yet. Enable{" "}
        <span className="font-medium">virtual switches &amp; networks</span>{" "}
        sync on its source to populate this.
      </p>
    )

  const vmCx = PAD + VM_W / 2
  const railsY = (i: number) => PAD + VM_H + DROP + i * (RAIL_H + RAIL_GAP)
  const height = railsY(conns.length - 1) + RAIL_H + PAD
  const colorFor = (i: number) =>
    conns[i].net?.vlan?.color || PALETTE[i % PALETTE.length]

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Network topology
      </h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
        <svg width={W} height={height} style={{ fontFamily: "inherit" }}>
          {/* legs — ribbon-cable lanes: each attachment runs box → its rail in
              its own parallel lane, labelled above the rail it plugs into */}
          {conns.map(({ iface }, i) => {
            const color = colorFor(i)
            const lx = vmCx + (i - (conns.length - 1) / 2) * 8
            return (
              <line
                key={iface.id}
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

          {/* interface labels — drawn after the lanes and placed clear of the
              whole ribbon, so a lane never crosses its own or another label */}
          {conns.map(({ iface }, i) => (
            <text
              key={`lbl-${iface.id}`}
              x={vmCx + ((conns.length - 1) / 2) * 8 + 10}
              y={railsY(i) - 5}
              fontSize={10}
              className="font-mono"
              fill="var(--muted-foreground)"
            >
              {iface.name}
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
          {conns.map(({ iface, net }, i) => {
            const color = colorFor(i)
            const y = railsY(i)
            const label =
              (net?.name ?? iface.vlan!.name) + `  ·  VLAN ${iface.vlan!.vlan_id}`
            return (
              <g
                key={`rail-${iface.id}`}
                className="cursor-pointer"
                onClick={() =>
                  nav({ to: "/vlans/$id", params: { id: iface.vlan!.id } })
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
                {net?.vswitch_name && (
                  <text
                    x={W - PAD - 12}
                    y={y + RAIL_H / 2 + 4}
                    fontSize={10}
                    textAnchor="end"
                    fill={railText(color)}
                    opacity={0.85}
                  >
                    {fit(net.vswitch_name, 28)}
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
