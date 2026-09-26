import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"

// A breakout cable as the backend sends it (api/topology_views.py
// `_links_from_cables`): one cable "TEST" (cat5e) whose single A end,
// fw-01:ethernet1/4, fans out to five B ends on two devices - core-b
// Ethernet1/6, 1/3, 1/7 and asw-01 Gi1/0/3, Gi1/0/4. It arrives as one
// edge per device pair, each with its share of the A x B cross product,
// all with the same cable id. Beside it: two separate cables between fw-01
// and core-c (a real "2x" in Simple), and an ordinary uplink.

export const FAN_DEV = {
  fw: "10000000-0000-4000-8000-000000000001",
  coreB: "20000000-0000-4000-8000-000000000002",
  asw: "30000000-0000-4000-8000-000000000003",
  coreC: "40000000-0000-4000-8000-000000000004",
} as const

export const FAN_CABLE = "c0ffee00-fa00-4000-8000-000000000001"

const node = (
  key: keyof typeof FAN_DEV,
  name: string,
  role: { name: string; color: string }
): TopoNode => ({
  id: `dev:${FAN_DEV[key]}`,
  type: "device",
  data: { device_id: FAN_DEV[key], name, role },
})

const FIREWALL = { name: "Firewall", color: "#f59e0b" }
const CORE = { name: "Core", color: "#e11d48" }
const ACCESS = { name: "Access", color: "#2563eb" }

type Pair = NonNullable<NonNullable<TopoEdge["data"]>["pairs"]>[number]

/** A pair as the backend orients it: `a` on the edge's source. */
function pair(
  src: [string, string, string],
  dst: [string, string, string]
): Pair {
  return {
    a: `${src[0]}:${src[1]}`,
    b: `${dst[0]}:${dst[1]}`,
    a_port: src[1],
    b_port: dst[1],
    a_id: src[2],
    a_kind: "interface",
    b_id: dst[2],
    b_kind: "interface",
  }
}

const TRUNK: [string, string, string] = [
  "fw-01",
  "ethernet1/4",
  "a0000000-0000-4000-8000-000000000104",
]
const CORE_LEGS: [string, string, string][] = [
  ["core-b", "Ethernet1/6", "b0000000-0000-4000-8000-000000000206"],
  ["core-b", "Ethernet1/3", "b0000000-0000-4000-8000-000000000203"],
  ["core-b", "Ethernet1/7", "b0000000-0000-4000-8000-000000000207"],
]
const ASW_LEGS: [string, string, string][] = [
  ["asw-01", "Gi1/0/3", "c0000000-0000-4000-8000-000000000303"],
  ["asw-01", "Gi1/0/4", "c0000000-0000-4000-8000-000000000304"],
]

const fanData = (pairs: Pair[]): NonNullable<TopoEdge["data"]> => ({
  cable_id: FAN_CABLE,
  cable_numid: 42,
  cable_type: "cat5e",
  cable_label: "TEST",
  color: "",
  status: "connected",
  pairs,
  lag: { a: null, b: null },
})

const plain = (
  id: string,
  src: keyof typeof FAN_DEV,
  dst: keyof typeof FAN_DEV,
  a: [string, string, string],
  b: [string, string, string]
): TopoEdge => ({
  id: `e:${id}:${FAN_DEV[src]}:${FAN_DEV[dst]}`,
  source: `dev:${FAN_DEV[src]}`,
  target: `dev:${FAN_DEV[dst]}`,
  type: "cable",
  data: {
    cable_id: id,
    cable_type: "cat6",
    cable_label: "",
    status: "connected",
    pairs: [pair(a, b)],
    lag: { a: null, b: null },
  },
})

export const fanoutGraph: TopologyGraph = {
  nodes: [
    node("fw", "fw-01", FIREWALL),
    node("coreB", "core-b", CORE),
    node("asw", "asw-01", ACCESS),
    node("coreC", "core-c", CORE),
  ],
  edges: [
    // fw sorts before core-b: the fw end is `a`.
    {
      id: `e:${FAN_CABLE}:${FAN_DEV.fw}:${FAN_DEV.coreB}`,
      source: `dev:${FAN_DEV.fw}`,
      target: `dev:${FAN_DEV.coreB}`,
      type: "cable",
      data: fanData(CORE_LEGS.map((leg) => pair(TRUNK, leg))),
    },
    // fw sorts before asw too.
    {
      id: `e:${FAN_CABLE}:${FAN_DEV.fw}:${FAN_DEV.asw}`,
      source: `dev:${FAN_DEV.fw}`,
      target: `dev:${FAN_DEV.asw}`,
      type: "cable",
      data: fanData(ASW_LEGS.map((leg) => pair(TRUNK, leg))),
    },
    plain(
      "c0ffee00-0000-4000-8000-000000000011",
      "fw",
      "coreC",
      ["fw-01", "ethernet1/6", "a0000000-0000-4000-8000-000000000106"],
      ["core-c", "Ethernet1/13", "d0000000-0000-4000-8000-000000000413"]
    ),
    plain(
      "c0ffee00-0000-4000-8000-000000000012",
      "fw",
      "coreC",
      ["fw-01", "ethernet1/7", "a0000000-0000-4000-8000-000000000107"],
      ["core-c", "Ethernet1/11", "d0000000-0000-4000-8000-000000000411"]
    ),
    plain(
      "c0ffee00-0000-4000-8000-000000000013",
      "coreB",
      "asw",
      ["core-b", "Ethernet1/1", "b0000000-0000-4000-8000-000000000201"],
      ["asw-01", "Te1/1/1", "c0000000-0000-4000-8000-000000000311"]
    ),
  ],
}
