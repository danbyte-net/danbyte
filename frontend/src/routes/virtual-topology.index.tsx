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
// OpenStack-style rails: each network is a full-width horizontal bar, VMs are
// drawn ONCE and sit in the band under their topmost network, with a vertical
// connector down to every other network they attach to.
const PAD = 32
const EXT_H = 30
const STRIP_H = 42
const STRIP_GAP = 16
const RAIL_H = 30
const RAIL_GAP = 14 // gap under a rail with no VMs in its band
const VM_W = 140
const VM_H = 48
const VM_GAP = 18
const COL_PITCH = VM_W + VM_GAP
const BAND_PAD = 18 // space above/below a VM row (room for leg labels)
const BAND_H = VM_H + 2 * BAND_PAD
const LABEL_RESERVE = 216 // rail label zone — VM columns start after it
const ADP_W = 116
const ADP_H = 34
const ADP_GAP = 8

// Deterministic rail palette — shades of the Danbyte blue, used when the
// network's VLAN has no zone colour. A zone colour (zones carry firewall
// semantics: inside/outside/prod/admin…) overrides it; a zone is never
// required just to get a colour.
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

/** Colour for the little status pill on a VM box's corner. */
function statusPill(status: string | null): { bg: string; fg: string } {
  const s = (status || "").toLowerCase()
  if (/(active|running|up|online|powered.?on)/.test(s))
    return { bg: "#10b981", fg: "#fff" }
  if (/(off|down|decom|failed|stopped|suspend)/.test(s))
    return { bg: "#ef4444", fg: "#fff" }
  return { bg: "var(--muted)", fg: "var(--muted-foreground)" }
}

/** Truncate to fit a node width (SVG text doesn't wrap). */
function fit(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Black or white label for a solid rail, by perceived luminance (Rec. 709). */
export function railText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#fff"
  const n = parseInt(m[1], 16)
  const l =
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return l > 150 ? "#111" : "#fff"
}

interface LaidRail {
  id: string
  y: number
  color: string
  label: string
  vlan: { id: string; vlan_id: number } | null
}
interface LaidStrip {
  id: string
  y: number
  name: string
  kind: string
  clickable: boolean
  adapters: { key: string; ifaceId: string; x: number; nic: string; host: string }[]
}
interface LaidVm {
  id: string
  x: number
  y: number
  name: string
  status: string | null
}
interface Laid {
  width: number
  height: number
  strips: LaidStrip[]
  rails: LaidRail[]
  vms: LaidVm[]
  lines: {
    key: string
    x: number
    y1: number
    y2: number
    color: string
    label?: string
    labelY?: number
  }[]
}

function layout(
  groups: [string, VirtNetwork[]][],
  swById: Map<string, VirtualSwitch>
): Laid {
  // 1. Flatten rails in section order; remember which section each belongs to.
  const rails: { net: VirtNetwork; section: number }[] = []
  const sections = groups.map(([swId, nets], si) => {
    const sorted = [...nets].sort(
      (a, b) => (a.vlan?.vlan_id ?? 9999) - (b.vlan?.vlan_id ?? 9999)
    )
    const start = rails.length
    for (const n of sorted) rails.push({ net: n, section: si })
    return { swId, start, end: rails.length - 1 }
  })

  // 2. Dedupe VMs across every rail → the rail indexes each VM attaches to.
  const byVm = new Map<
    string,
    {
      name: string
      status: string | null
      railIdxs: number[]
      ifaces: Map<number, string>
    }
  >()
  rails.forEach((r, idx) => {
    for (const vm of r.net.vms) {
      let e = byVm.get(vm.id)
      if (!e) {
        e = { name: vm.name, status: vm.status, railIdxs: [], ifaces: new Map() }
        byVm.set(vm.id, e)
      }
      e.railIdxs.push(idx)
      if (vm.iface) e.ifaces.set(idx, vm.iface)
    }
  })
  const vmsSorted = [...byVm.entries()].sort((a, b) => {
    const ra = a[1].railIdxs[0]
    const rb = b[1].railIdxs[0]
    return ra !== rb ? ra - rb : a[1].name.localeCompare(b[1].name)
  })

  // 3. Column allocation — a VM occupies its column in every band its
  //    connector passes through, so nothing ever overlaps.
  const bandCols: Set<number>[] = rails.map(() => new Set())
  const placed: {
    id: string
    name: string
    status: string | null
    col: number
    band: number
    railIdxs: number[]
    ifaces: Map<number, string>
  }[] = []
  for (const [id, v] of vmsSorted) {
    const first = v.railIdxs[0]
    const last = v.railIdxs[v.railIdxs.length - 1]
    // Reserve the column through the leg's LAST band too — otherwise a VM in
    // the terminal band sits directly under the leg and looks attached to it.
    const span: number[] = []
    for (let b = first; b <= last; b++) span.push(b)
    let col = 0
    while (span.some((b) => bandCols[b].has(col))) col++
    span.forEach((b) => bandCols[b].add(col))
    placed.push({
      id, name: v.name, status: v.status, col, band: first,
      railIdxs: v.railIdxs, ifaces: v.ifaces,
    })
  }
  const maxCols = placed.reduce((m, p) => Math.max(m, p.col + 1), 0)
  const width = Math.max(
    PAD * 2 + LABEL_RESERVE + maxCols * COL_PITCH + COL_PITCH / 2,
    900
  )

  // 4. Vertical pass: external bar → per section: strip → rails with bands.
  const strips: LaidStrip[] = []
  const laidRails: LaidRail[] = []
  const railY: number[] = []
  const bandY: number[] = []
  let y = PAD / 2 + EXT_H + STRIP_GAP
  for (const sec of sections) {
    const sw = swById.get(sec.swId)
    const ups = sw?.uplink_interfaces ?? []
    const adapters = ups.map((u, i) => ({
      key: `${sec.swId}:${u.id}`,
      ifaceId: u.id,
      x: width - PAD - (ups.length - i) * (ADP_W + ADP_GAP) + ADP_GAP,
      nic: u.name,
      host: u.device.name,
    }))
    strips.push({
      id: sec.swId,
      y,
      name: sw?.name ?? "Unassigned networks",
      kind: sw?.kind_display ?? "",
      clickable: !!sw,
      adapters,
    })
    y += STRIP_H + STRIP_GAP
    for (let i = sec.start; i <= sec.end; i++) {
      const { net } = rails[i]
      laidRails.push({
        id: net.id,
        y,
        color: net.vlan?.color || PALETTE[i % PALETTE.length],
        label:
          (net.name || net.ext_key) +
          (net.vlan ? `  ·  VLAN ${net.vlan.vlan_id}` : ""),
        vlan: net.vlan,
      })
      railY[i] = y
      y += RAIL_H
      bandY[i] = y
      y += bandCols[i].size > 0 ? BAND_H : RAIL_GAP
    }
    y += STRIP_GAP / 2
  }

  // 5. VM boxes + solid connectors, one coloured segment per attached network
  //    (the OpenStack look: the stub carries the network's colour).
  const vms: LaidVm[] = []
  const lines: Laid["lines"] = []
  for (const p of placed) {
    const stagger = (p.band % 2) * (COL_PITCH / 2)
    const x = PAD + LABEL_RESERVE + stagger + p.col * COL_PITCH + VM_W / 2
    const boxY = bandY[p.band] + BAND_PAD
    vms.push({ id: p.id, x, y: boxY, name: p.name, status: p.status })
    const firstRail = p.railIdxs[0]
    // One full leg per attachment, box → rail, fanned into parallel lanes a
    // few px apart (ribbon-cable style) so every colour stays trackable and
    // visibly plugs into the VM — sequential segments read as disconnected.
    const n = p.railIdxs.length
    p.railIdxs.forEach((r, k) => {
      const lx = x + (k - (n - 1) / 2) * 6
      if (r === firstRail) {
        lines.push({
          key: `u-${p.id}`,
          x: lx,
          y1: railY[r] + RAIL_H / 2, // under the bar — rails draw on top
          y2: boxY,
          color: laidRails[r].color,
          label: p.ifaces.get(r),
          labelY: boxY - 4,
        })
      } else {
        lines.push({
          key: `d-${p.id}-${r}`,
          x: lx,
          y1: boxY + VM_H,
          y2: railY[r] + RAIL_H / 2,
          color: laidRails[r].color,
          label: p.ifaces.get(r),
          labelY: railY[r] - 4,
        })
      }
    })
  }

  const height = y + PAD / 2
  return { width, height, strips, rails: laidRails, vms, lines }
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
            {/* external network bar */}
            <rect
              x={PAD}
              y={PAD / 2}
              width={laid.width - 2 * PAD}
              height={EXT_H}
              rx={6}
              fill="var(--muted)"
              stroke="var(--border)"
            />
            <text
              x={PAD + 12}
              y={PAD / 2 + EXT_H / 2 + 4}
              fontSize={12}
              fontWeight={600}
              fill="var(--muted-foreground)"
            >
              External network
            </text>

            {/* connectors (behind boxes) — solid, in the network's colour */}
            {laid.lines.map((l) => (
              <g key={l.key}>
                <line
                  x1={l.x}
                  y1={l.y1}
                  x2={l.x}
                  y2={l.y2}
                  stroke={l.color}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
                {l.label && (
                  <text
                    x={l.x + 7}
                    y={l.labelY ?? Math.max(l.y1, l.y2) - 5}
                    fontSize={9}
                    className="font-mono"
                    fill="var(--muted-foreground)"
                  >
                    {l.label}
                  </text>
                )}
              </g>
            ))}

            {/* switch strips + their physical adapters */}
            {laid.strips.map((s) => (
              <g key={s.id}>
                <g
                  className={s.clickable ? "cursor-pointer" : undefined}
                  onClick={() =>
                    s.clickable &&
                    nav({ to: "/virtual-switches/$id", params: { id: s.id } })
                  }
                >
                  <text
                    x={PAD}
                    y={s.y + 18}
                    fontSize={13}
                    fontWeight={600}
                    fill="var(--foreground)"
                  >
                    {fit(s.name, 40)}
                  </text>
                  <text
                    x={PAD}
                    y={s.y + 34}
                    fontSize={10}
                    fill="var(--muted-foreground)"
                  >
                    {s.kind}
                  </text>
                </g>
                {s.adapters.map((a) => (
                  <g
                    key={a.key}
                    className="cursor-pointer"
                    onClick={() =>
                      nav({ to: "/interfaces/$id", params: { id: a.ifaceId } })
                    }
                  >
                    <rect
                      x={a.x}
                      y={s.y + (STRIP_H - ADP_H) / 2}
                      width={ADP_W}
                      height={ADP_H}
                      rx={6}
                      fill="var(--muted)"
                      stroke="var(--border)"
                    />
                    <text
                      x={a.x + ADP_W / 2}
                      y={s.y + STRIP_H / 2 - 2}
                      fontSize={10}
                      fontWeight={600}
                      textAnchor="middle"
                      fill="var(--foreground)"
                      className="font-mono"
                    >
                      {fit(a.nic, 14)}
                    </text>
                    <text
                      x={a.x + ADP_W / 2}
                      y={s.y + STRIP_H / 2 + 11}
                      fontSize={9}
                      textAnchor="middle"
                      fill="var(--muted-foreground)"
                    >
                      {fit(a.host, 16)}
                    </text>
                  </g>
                ))}
              </g>
            ))}

            {/* network rails — full-width coloured bars */}
            {laid.rails.map((r) => (
              <g
                key={r.id}
                className={r.vlan ? "cursor-pointer" : undefined}
                onClick={() =>
                  r.vlan && nav({ to: "/vlans/$id", params: { id: r.vlan.id } })
                }
              >
                <rect
                  x={PAD}
                  y={r.y}
                  width={laid.width - 2 * PAD}
                  height={RAIL_H}
                  rx={6}
                  fill={r.color}
                  fillOpacity={1}
                />
                <text
                  x={PAD + 12}
                  y={r.y + RAIL_H / 2 + 4}
                  fontSize={12}
                  fontWeight={600}
                  fill={railText(r.color)}
                >
                  {fit(r.label, 34)}
                </text>
              </g>
            ))}

            {/* VM boxes — one per VM, neutral card with a corner status pill */}
            {laid.vms.map((vm) => {
              const pill = statusPill(vm.status)
              const label = fit(vm.status || "", 14)
              const pw = label ? label.length * 5.4 + 12 : 0
              return (
                <g
                  key={vm.id}
                  className="cursor-pointer"
                  onClick={() =>
                    nav({ to: "/virtual-machines/$id", params: { id: vm.id } })
                  }
                >
                  <rect
                    x={vm.x - VM_W / 2}
                    y={vm.y}
                    width={VM_W}
                    height={VM_H}
                    rx={8}
                    fill="var(--card)"
                    stroke="var(--border)"
                  />
                  <text
                    x={vm.x}
                    y={vm.y + (label ? 34 : VM_H / 2 + 4)}
                    fontSize={12}
                    fontWeight={600}
                    textAnchor="middle"
                    fill="var(--foreground)"
                  >
                    {fit(vm.name, 16)}
                  </text>
                  {label && (
                    <g>
                      <rect
                        x={vm.x + VM_W / 2 - pw - 5}
                        y={vm.y + 5}
                        width={pw}
                        height={14}
                        rx={4}
                        fill={pill.bg}
                      />
                      <text
                        x={vm.x + VM_W / 2 - pw / 2 - 5}
                        y={vm.y + 15}
                        fontSize={9}
                        fontWeight={600}
                        textAnchor="middle"
                        fill={pill.fg}
                      >
                        {label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Cloud className="h-3.5 w-3.5" />
        Networks are rails; each VM appears once, connected by a line to every
        network it attaches to. Rail colour follows the VLAN's zone (set a zone
        on the VLAN to pick it); unzoned networks get a palette shade. Click any
        node to open it.
      </div>
    </ListPageShell>
  )
}
