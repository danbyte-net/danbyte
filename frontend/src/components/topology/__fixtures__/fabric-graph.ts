import type { TopoEdge, TopoNode, TopoPort, TopologyGraph } from "@/lib/api"

// A small but complete fabric in the exact shape the backend sends
// (api/topology_views.py `_build_graph`, monitoring/snmp_topology.py ghosts,
// routing/topology.py BGP), for the build() golden parity test.
//
// Device ids are fixed UUIDs. The backend orients every cable edge by sorted
// device UUID, so they are chosen to make some leaf → spine edges arrive
// "backwards" - the canvas re-orients them hub → leaf by degree.
export const DEV = {
  leaf1: "2b8f41d0-6a3e-4c1b-9f02-3d7e5a1c0b01",
  leaf2: "3f60c2a4-1d9b-4e57-8a13-6c2f0e9d4b02",
  fw1: "5d93e7b1-0c4a-4f28-b6d5-9a1e3c7f2d03",
  ppc: "64f1a8c3-7e2d-4b90-a5c1-2f8d6e0b3a04",
  spine1: "7c1d5e92-3b6f-4a0d-8e47-1b9c2d5f6e05",
  spine2: "9e4b0a7d-5c1e-4d83-b2f6-8a3d7c1e9f06",
  leaf3: "a1c46f28-9d0b-4e15-a7c3-5e2b8d4f1a07",
  leaf4: "c5d2b9e4-2a7f-4c61-9d08-7f1e3a6c5b08",
  ppa: "d2e5f8a1-3b6c-4d9e-8f12-4a7b0c3d6e11",
  ppb: "d7a0c3e6-9f2b-4e5d-a813-6b9c2e5f8a12",
  srv1: "e8a73c05-4f9e-4b2d-8c16-0d5a9e7b2c09",
  oob1: "f0b3d6a1-8e5c-4f72-b9a4-3c6e1d8f0a10",
} as const
type DevKey = keyof typeof DEV

export const devId = (k: DevKey) => `dev:${DEV[k]}`

const SITE = {
  dc1: "11111111-5a1e-4c3d-9b2a-000000000001",
  dc2: "22222222-5a1e-4c3d-9b2a-000000000002",
  dc3: "33333333-5a1e-4c3d-9b2a-000000000003",
} as const

const ROLE = {
  spine: { name: "Spine", color: "#6366f1", is_patch_panel: false },
  leaf: { name: "Leaf", color: "#0ea5e9", is_patch_panel: false },
  firewall: { name: "Firewall", color: "#ef4444", is_patch_panel: false },
  server: { name: "Server", color: "#10b981", is_patch_panel: false },
  console: { name: "Console server", color: "#a855f7", is_patch_panel: false },
  panel: { name: "Patch panel", color: "#71717a", is_patch_panel: true },
}

interface DeviceMeta {
  name: string
  role: (typeof ROLE)[keyof typeof ROLE] | null
  status: string
  status_display: string
  device_type: string
  site: string | null
  location: string | null
  primary_ip: string | null
  interface_count: number
}

const DC1 = "Oslo DC1"
const DC2 = "Oslo DC2"
const DC3 = "Oslo DC3"

const DEVICES: Record<DevKey, DeviceMeta> = {
  spine1: meta("spine-01", ROLE.spine, "DCS-7280SR3", DC1, "10.0.0.1"),
  spine2: meta("spine-02", ROLE.spine, "DCS-7280SR3", DC1, "10.0.0.2"),
  leaf1: meta("leaf-01", ROLE.leaf, "N9K-C93180YC", DC1, "10.0.1.1"),
  leaf2: meta("leaf-02", ROLE.leaf, "N9K-C93180YC", DC1, "10.0.1.2"),
  leaf3: meta("leaf-03", ROLE.leaf, "N9K-C93180YC", DC2, "10.0.1.3"),
  leaf4: meta("leaf-04", ROLE.leaf, "N9K-C93180YC", DC3, "10.0.1.4"),
  fw1: meta("fw-01", ROLE.firewall, "PA-3220", DC1, "10.0.2.1"),
  srv1: meta("srv-db-01", ROLE.server, "PowerEdge R750", null, null),
  oob1: meta("oob-con-01", ROLE.console, "CM8100", DC1, "10.0.9.1"),
  ppc: meta("pp-c01", ROLE.panel, "LC-24", DC3, null),
  ppa: meta("pp-a01", ROLE.panel, "LC-24", DC2, null),
  ppb: meta("pp-b01", ROLE.panel, "LC-24", null, null),
}

function meta(
  name: string,
  role: DeviceMeta["role"],
  device_type: string,
  site: string | null,
  primary_ip: string | null
): DeviceMeta {
  return {
    name,
    role,
    status: "active",
    status_display: "Active",
    device_type,
    site,
    location: site ? "Hall A" : null,
    primary_ip,
    interface_count: role?.is_patch_panel ? 0 : 48,
  }
}

type Kind = TopoPort["kind"]
type End = [DevKey, string, Kind?]

interface CableSpec {
  id: string
  numid: number
  type: string
  label?: string
  color?: string
  status?: string
  length?: string | null
  speed?: string | null
  via?: string[]
  /** One or more [A end, B end] port pairs on the same cable. */
  pairs: [End, End][]
  /** The aggregate each end's interface belongs to (A end, B end). */
  lag?: [string, string]
  marked?: boolean
}

const seq = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`
const cab = (n: number) => seq("c0ffee00", n)
const session = (n: number) => seq("b9000000", n)
const lagId = (k: DevKey) => `1a900000-0000-4000-8000-${DEV[k].slice(-12)}`

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const KEYS = Object.keys(DEV) as DevKey[]
const ALIAS = new Map<string, string>([
  ...KEYS.map((k): [string, string] => [DEV[k], `@${DEVICES[k].name}`]),
  ...KEYS.map((k): [string, string] => [lagId(k), `@${DEVICES[k].name}.lag`]),
  ...Object.entries(SITE).map(([k, id]): [string, string] => [id, `@${k}`]),
  ...Array.from({ length: 20 }, (_, i): [string, string] => [
    cab(i + 1),
    `@c${i + 1}`,
  ]),
  ...Array.from({ length: 3 }, (_, i): [string, string] => [
    session(i + 1),
    `@session${i + 1}`,
  ]),
])

/** The fixture's UUIDs → readable "@leaf-01" / "@c12" names, so golden
 * files read as a diagram rather than a wall of hex. */
export function aliasIds(text: string): string {
  return text.replace(UUID_RE, (u) => ALIAS.get(u) ?? u)
}

/** A cable edge as `_build_graph` emits it: source/target sorted by device
 * UUID, pairs and lag oriented with them. */
function cableEdge(c: CableSpec): TopoEdge {
  const [a0, b0] = c.pairs[0]
  const flip = DEV[a0[0]] > DEV[b0[0]]
  const [src, dst] = flip ? [b0[0], a0[0]] : [a0[0], b0[0]]
  // The aggregate's own interface id - one aggregate per device here.
  const lagEnd = (dev: DevKey, name: string) => ({ id: lagId(dev), name })
  const [la, lb] = c.lag
    ? [lagEnd(a0[0], c.lag[0]), lagEnd(b0[0], c.lag[1])]
    : [null, null]
  const lag = flip ? { a: lb, b: la } : { a: la, b: lb }
  return {
    id: `e:${c.id}:${DEV[src]}:${DEV[dst]}`,
    source: `dev:${DEV[src]}`,
    target: `dev:${DEV[dst]}`,
    type: "cable",
    data: {
      cable_id: c.id,
      cable_numid: c.numid,
      cable_type: c.type,
      cable_label: c.label ?? "",
      color: c.color ?? "",
      status: c.status ?? "connected",
      length: c.length ?? null,
      length_unit: "m",
      speed: c.speed ?? null,
      via: c.via ?? [],
      pairs: c.pairs.map(([a, b]) => {
        const [s, t] = flip ? [b, a] : [a, b]
        return {
          a: `${DEVICES[s[0]].name}:${s[1]}`,
          b: `${DEVICES[t[0]].name}:${t[1]}`,
          a_port: s[1],
          b_port: t[1],
        }
      }),
      lag,
      ...(c.marked !== undefined ? { marked: c.marked } : {}),
    },
  }
}

/** Cabled ports per device, in the order `_build_graph` notes them: fronts
 * first (merged with the cabled rear on the same strand), then the rest. */
function portsOf(
  cables: CableSpec[],
  strands: Partial<Record<DevKey, Record<string, string>>> = {}
): Map<DevKey, TopoPort[]> {
  const seen = new Map<DevKey, Map<string, Kind>>()
  const note = ([dev, port, kind]: End) => {
    const m = seen.get(dev) ?? seen.set(dev, new Map()).get(dev)!
    if (!m.has(port)) m.set(port, kind ?? "interface")
  }
  for (const c of cables)
    for (const [a, b] of c.pairs) {
      note(a)
      note(b)
    }
  const out = new Map<DevKey, TopoPort[]>()
  for (const [dev, m] of seen) {
    const consumed = new Set<string>()
    const ports: TopoPort[] = []
    for (const [name, kind] of m) {
      if (kind !== "front") continue
      const rear = strands[dev]?.[name]
      if (rear && m.get(rear) === "rear" && !consumed.has(rear)) {
        consumed.add(rear)
        ports.push({ name, kind, pair: rear })
      } else ports.push({ name, kind })
    }
    for (const [name, kind] of m)
      if (kind !== "front" && !consumed.has(name)) ports.push({ name, kind })
    out.set(dev, ports)
  }
  return out
}

function deviceNode(k: DevKey, ports: TopoPort[]): TopoNode {
  const d = DEVICES[k]
  return {
    id: devId(k),
    type: "device",
    data: {
      device_id: DEV[k],
      name: d.name,
      status: d.status,
      status_display: d.status_display,
      device_type: d.device_type,
      role: d.role,
      site: d.site,
      location: d.location,
      primary_ip: d.primary_ip,
      interface_count: d.interface_count,
      panel: !!d.role?.is_patch_panel,
      ports,
    },
  }
}

/** Devices in scope, ordered by name like the device queryset. */
function nodesFor(keys: DevKey[], ports: Map<DevKey, TopoPort[]>): TopoNode[] {
  return [...keys]
    .sort((a, b) => DEVICES[a].name.localeCompare(DEVICES[b].name))
    .map((k) => deviceNode(k, ports.get(k) ?? []))
}

// ── The fabric (collapse_panels=1) ──────────────────────────────────────────

const up = (
  n: number,
  spine: DevKey,
  sp: string,
  leaf: DevKey,
  lp: string,
  extra: Partial<CableSpec> = {}
): CableSpec => ({
  id: cab(n),
  numid: n,
  type: "dac-active",
  length: "3.00",
  speed: "100G",
  pairs: [
    [
      [spine, sp],
      [leaf, lp],
    ],
  ],
  ...extra,
})

/** Direct leaf-03 → srv-db-01 copper: on the fabric and, unmarked, on the
 * trace map (same two devices, not part of the traced run). */
const SPARE_LEAF3_SRV1: CableSpec = {
  id: cab(17),
  numid: 17,
  type: "cat6",
  speed: "1G",
  pairs: [
    [
      ["leaf3", "Ethernet1/47"],
      ["srv1", "eno2"],
    ],
  ],
}

const FABRIC_CABLES: CableSpec[] = [
  // Two parallel, non-aggregated uplinks: Flat folds them into one ×2 edge.
  up(1, "spine1", "Ethernet1/1", "leaf1", "Ethernet1/49"),
  up(2, "spine1", "Ethernet1/2", "leaf1", "Ethernet1/50"),
  up(3, "spine1", "Ethernet1/3", "leaf2", "Ethernet1/49"),
  up(4, "spine1", "Ethernet1/4", "leaf3", "Ethernet1/49", {
    type: "smf",
    color: "#f59e0b",
    speed: "40G",
  }),
  up(5, "spine1", "Ethernet1/5", "leaf4", "Ethernet1/49"),
  up(6, "spine2", "Ethernet1/1", "leaf1", "Ethernet1/51"),
  up(7, "spine2", "Ethernet1/2", "leaf2", "Ethernet1/51"),
  up(8, "spine2", "Ethernet1/3", "leaf3", "Ethernet1/51", {
    type: "smf",
    color: "#f59e0b",
    speed: "40G",
  }),
  up(9, "spine2", "Ethernet1/4", "leaf4", "Ethernet1/51", {
    status: "planned",
    label: "SP2-LF4",
  }),
  // vPC peer link: two members of Po10 on both ends - one lagbundle edge.
  {
    id: cab(10),
    numid: 10,
    type: "dac-passive",
    length: "1.00",
    speed: "100G",
    pairs: [
      [
        ["leaf1", "Ethernet1/53"],
        ["leaf2", "Ethernet1/53"],
      ],
    ],
    lag: ["Po10", "Po10"],
  },
  {
    id: cab(11),
    numid: 11,
    type: "dac-passive",
    length: "1.00",
    speed: "100G",
    pairs: [
      [
        ["leaf1", "Ethernet1/54"],
        ["leaf2", "Ethernet1/54"],
      ],
    ],
    lag: ["Po10", "Po10"],
  },
  // One cable, two terminations per end: a ×2 label on the Wiring card.
  {
    id: cab(12),
    numid: 12,
    type: "cat6",
    label: "FW-UPLINK",
    color: "#3b82f6",
    length: "5.00",
    speed: "10G",
    pairs: [
      [
        ["fw1", "ethernet1/1"],
        ["leaf4", "Ethernet1/1"],
      ],
      [
        ["fw1", "ethernet1/2"],
        ["leaf4", "Ethernet1/2"],
      ],
    ],
  },
  // Collapsed run through two panels: one end-to-end edge with `via`.
  {
    id: cab(13),
    numid: 13,
    type: "smf",
    label: "DB uplink",
    speed: "25G",
    via: ["pp-a01", "pp-b01"],
    pairs: [
      [
        ["leaf3", "Ethernet1/48"],
        ["srv1", "eno1"],
      ],
    ],
  },
  // A run that dead-ends in a panel whose rear is uncabled: the panel stays.
  {
    id: cab(14),
    numid: 14,
    type: "cat6",
    status: "planned",
    speed: "1G",
    pairs: [
      [
        ["leaf4", "Ethernet1/48"],
        ["ppc", "1", "front"],
      ],
    ],
  },
  // A direct copper link alongside the panel run: Flat bundles the pair.
  SPARE_LEAF3_SRV1,
]

/** LLDP adjacency with no cable (monitoring/snmp_topology.py ghost_edges). */
const GHOST_LEAF2_FW1: TopoEdge = {
  id: `ghost:${DEV.leaf2}:${DEV.fw1}`,
  source: devId("leaf2"),
  target: devId("fw1"),
  type: "ghost",
  data: {
    source_device: DEV.leaf2,
    target_device: DEV.fw1,
    local_port: "Ethernet1/10",
    remote_port: "ethernet1/3",
    pairs: [{ a: "Ethernet1/10", b: "ethernet1/3" }],
  },
}

/** BGP overlay edges (routing/topology.py): sorted by id, vrf "" → null. */
const BGP_EDGES: TopoEdge[] = [
  {
    id: `bgp:${DEV.fw1}:${DEV.spine1}:`,
    source: devId("fw1"),
    target: devId("spine1"),
    type: "bgp",
    data: {
      sessions: [session(1)],
      kind: "ebgp",
      vrf: null,
      address_families: ["ipv4-unicast"],
      a_asn: 65100,
      b_asn: 65000,
      pairs: [{ a: "AS65100", b: "AS65000" }],
    },
  },
  {
    id: `bgp:${DEV.spine1}:${DEV.spine2}:underlay`,
    source: devId("spine1"),
    target: devId("spine2"),
    type: "bgp",
    data: {
      sessions: [session(2), session(3)],
      kind: "ibgp",
      vrf: "underlay",
      address_families: ["ipv4-unicast", "l2vpn-evpn"],
      a_asn: 65000,
      b_asn: 65000,
      pairs: [{ a: "AS65000", b: "AS65000" }],
    },
  },
]

const FABRIC_DEVICES: DevKey[] = [
  "spine1",
  "spine2",
  "leaf1",
  "leaf2",
  "leaf3",
  "leaf4",
  "fw1",
  "srv1",
  "ppc",
  // No cables at all - an isolated card.
  "oob1",
]

/** The /topology page's graph: the cabling payload plus the LLDP ghosts and
 * BGP sessions it merges in (topology.index.tsx `fullGraph`). */
export const fabricGraph: TopologyGraph = {
  nodes: nodesFor(FABRIC_DEVICES, portsOf(FABRIC_CABLES)),
  edges: [...FABRIC_CABLES.map(cableEdge), GHOST_LEAF2_FW1, ...BGP_EDGES],
}

// ── group_by=site (api/topology_views.py `_grouped_graph`) ──────────────────

const grp = (id: string | null) => `grp:${id ?? "none"}`

export const groupedGraph: TopologyGraph = {
  nodes: [
    {
      id: grp(SITE.dc1),
      type: "group",
      data: {
        group_id: SITE.dc1,
        kind: "site",
        name: "Oslo DC1",
        device_count: 6,
        roles: [
          { name: "Leaf", color: ROLE.leaf.color, count: 2 },
          { name: "Spine", color: ROLE.spine.color, count: 2 },
          { name: "Console server", color: ROLE.console.color, count: 1 },
          { name: "Firewall", color: ROLE.firewall.color, count: 1 },
        ],
      },
    },
    {
      id: grp(SITE.dc2),
      type: "group",
      data: {
        group_id: SITE.dc2,
        kind: "site",
        name: "Oslo DC2",
        device_count: 1,
        roles: [{ name: "Leaf", color: ROLE.leaf.color, count: 1 }],
      },
    },
    {
      id: grp(SITE.dc3),
      type: "group",
      data: {
        group_id: SITE.dc3,
        kind: "site",
        name: "Oslo DC3",
        device_count: 2,
        roles: [
          { name: "Leaf", color: ROLE.leaf.color, count: 1 },
          { name: "Patch panel", color: ROLE.panel.color, count: 1 },
        ],
      },
    },
    {
      id: grp(null),
      type: "group",
      data: {
        group_id: null,
        kind: "site",
        name: "Unassigned",
        device_count: 1,
        roles: [{ name: "Server", color: ROLE.server.color, count: 1 }],
      },
    },
  ] as unknown as TopoNode[],
  edges: [
    groupEdge(SITE.dc1, SITE.dc2, 2, ["smf"]),
    groupEdge(SITE.dc1, SITE.dc3, 3, ["cat6", "dac-active"]),
    groupEdge(SITE.dc2, "none", 1, ["smf"]),
  ],
}

function groupEdge(
  a: string,
  b: string,
  cable_count: number,
  types: string[]
): TopoEdge {
  return {
    id: `ge:${a}:${b}`,
    source: `grp:${a}`,
    target: `grp:${b}`,
    type: "group",
    data: { cable_count, types } as unknown as TopoEdge["data"],
  }
}

// ── Trace map (api/topology_views.py `trace_device_graph`) ──────────────────
// leaf-03 → pp-a01 → trunk → pp-b01 → srv-db-01, panels shown (collapse
// off), the traced cables marked.

const TRACE_CABLES: CableSpec[] = [
  {
    id: cab(13),
    numid: 13,
    type: "smf",
    label: "DB uplink",
    speed: "25G",
    marked: true,
    pairs: [
      [
        ["leaf3", "Ethernet1/48"],
        ["ppa", "1", "front"],
      ],
    ],
  },
  {
    id: cab(15),
    numid: 15,
    type: "smf-os2",
    label: "TRUNK-A-B",
    color: "#eab308",
    length: "120.00",
    marked: true,
    pairs: [
      [
        ["ppa", "R1", "rear"],
        ["ppb", "R1", "rear"],
      ],
    ],
  },
  {
    id: cab(16),
    numid: 16,
    type: "smf",
    speed: "25G",
    marked: true,
    pairs: [
      [
        ["ppb", "1", "front"],
        ["srv1", "eno1"],
      ],
    ],
  },
  { ...SPARE_LEAF3_SRV1, marked: false },
]

const TRACE_KEYS: DevKey[] = ["leaf3", "ppa", "ppb", "srv1"]

export const traceGraph: TopologyGraph = (() => {
  // Every cable touching a traced device is loaded, so the cards keep their
  // out-of-scope ports (leaf-03's spine uplinks); only in-scope pairs draw.
  const raw = [
    ...TRACE_CABLES,
    ...FABRIC_CABLES.filter((c) => c.id !== cab(13) && c.id !== cab(17)),
  ]
  const ports = portsOf(raw, { ppa: { "1": "R1" }, ppb: { "1": "R1" } })
  const inScope = new Set(TRACE_KEYS.map(devId))
  return {
    nodes: nodesFor(TRACE_KEYS, ports),
    edges: TRACE_CABLES.map(cableEdge).filter(
      (e) => inScope.has(e.source) && inScope.has(e.target)
    ),
  }
})()

// ── Device mini-map (device-mini-topology.tsx) ──────────────────────────────
// leaf-02's `/map/` (1-hop, panels collapsed) merged with its LLDP ghost
// graph, whose neighbour node carries the reduced `_topo_node` shape.

const MINI_KEYS: DevKey[] = ["leaf1", "leaf2", "spine1", "spine2"]

export const miniOrigin = devId("leaf2")

export const miniMapGraph: TopologyGraph = (() => {
  // Ports are noted before the scope filter, so a card keeps every cabled
  // port even when the far end is out of the neighbourhood.
  const ports = portsOf(FABRIC_CABLES)
  const inScope = new Set(MINI_KEYS.map(devId))
  const cables = FABRIC_CABLES.map(cableEdge).filter(
    (e) => inScope.has(e.source) && inScope.has(e.target)
  )
  const fw = DEVICES.fw1
  const ghostNode: TopoNode = {
    id: devId("fw1"),
    type: "device",
    data: {
      device_id: DEV.fw1,
      name: fw.name,
      status: fw.status,
      status_display: fw.status_display,
      site: fw.site,
    },
  }
  return {
    nodes: [...nodesFor(MINI_KEYS, ports), ghostNode],
    edges: [...cables, GHOST_LEAF2_FW1],
  }
})()

/** leaf-02's port toward spine-01, for the hidden-origin-port case. */
export const miniHiddenPort = "Ethernet1/49"
