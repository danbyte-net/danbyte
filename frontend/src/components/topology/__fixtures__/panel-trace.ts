import type { TopoEdge, TopoNode, TraceGraph } from "@/lib/api"

// A cable trace through one patch panel, as `GET /api/cables/<id>/trace/`
// sends it: srv-01:eno2 → pp-01:front1, pp-01:rear1 → dist-01:Gi1/20, and
// a second cable on the panel's rear2 that is not part of the run. The
// device map's edges come uuid-ordered, so both cables of the run point
// INTO the panel (the panel's uuid sorts last) - which is what put the
// panel at one edge of the map with both strands leaving it the same way.

const DIST = "1a0c6f1e-5b2d-4c3a-9e10-000000000001"
const SRV = "7c2d4e6f-8a9b-4c1d-8e2f-000000000002"
const PP = "b3e5f7a9-1c2d-4e3f-8a4b-000000000003"

const IF_ENO2 = "4d8e0000-0000-4000-8000-0000000000e2"
const IF_GI20 = "f1a20000-0000-4000-8000-000000000120"
const FP1 = "9a270000-0000-4000-8000-0000000000f1"
const RP1 = "4b580000-0000-4000-8000-0000000000a1"

/** The traced cable (srv-01:eno2 → pp-01:front1). */
export const PANEL_CABLE = "d6000000-0000-4000-8000-000000000148"
const TRUNK = "b1100000-0000-4000-8000-000000000149"
const SPARE = "d1d20000-0000-4000-8000-000000000151"

export const panelDev = {
  dist: `dev:${DIST}`,
  srv: `dev:${SRV}`,
  pp: `dev:${PP}`,
} as const

const role = (name: string, color: string, panel = false) => ({
  id: `role-${name}`,
  name,
  slug: name.toLowerCase().replace(/ /g, "-"),
  color,
  icon: "",
  is_patch_panel: panel,
})

function card(
  id: string,
  name: string,
  r: ReturnType<typeof role>,
  ports: NonNullable<TopoNode["data"]["ports"]>,
  panel = false
): TopoNode {
  return {
    id: `dev:${id}`,
    type: "device",
    data: {
      device_id: id,
      name,
      status_display: "",
      status_mini: null,
      device_type: panel ? null : name.toUpperCase(),
      role: r,
      site: "DC1",
      panel,
      ports,
    },
  }
}

const NAME: Record<string, string> = {
  [DIST]: "dist-01",
  [SRV]: "srv-01",
  [PP]: "pp-01",
}

function cable(
  id: string,
  numid: number,
  [a, aPort, aKind]: [string, string, string],
  [b, bPort, bKind]: [string, string, string],
  marked: boolean
): TopoEdge {
  return {
    id: `e:${id}:${a}:${b}`,
    source: `dev:${a}`,
    target: `dev:${b}`,
    type: "cable",
    data: {
      cable_id: id,
      cable_numid: numid,
      cable_type: "cat6",
      cable_label: "",
      color: "",
      length: null,
      length_unit: "m",
      speed: "1G",
      via: [],
      pairs: [
        {
          a: `${NAME[a]}:${aPort}`,
          b: `${NAME[b]}:${bPort}`,
          a_port: aPort,
          b_port: bPort,
          a_kind: aKind,
          b_kind: bKind,
        },
      ],
      lag: { a: null, b: null },
      marked,
    },
  }
}

const port = (
  prefix: string,
  id: string,
  name: string,
  type: "interface" | "front_port" | "rear_port",
  device: string,
  deviceName: string
): TopoNode => ({
  id: `${prefix}:${id}`,
  type,
  data: { name, device_name: deviceName, device_id: device },
})

const membership = (device: string, portId: string): TopoEdge => ({
  id: `m:dev:${device}:${portId}`,
  source: `dev:${device}`,
  target: portId,
  type: "membership",
  data: {},
})

/** The trace of `PANEL_CABLE`, in the payload's order: the panel's front
 * port first, then the server's end, then the far end. */
export const panelTrace: TraceGraph = {
  origin: { type: "cable", id: PANEL_CABLE },
  complete: true,
  nodes: [
    port("fp", FP1, "front1", "front_port", PP, "pp-01"),
    { id: `dev:${PP}`, type: "device", data: { device_id: PP, name: "pp-01" } },
    port("rp", RP1, "rear1", "rear_port", PP, "pp-01"),
    port("if", IF_ENO2, "eno2", "interface", SRV, "srv-01"),
    {
      id: `dev:${SRV}`,
      type: "device",
      data: { device_id: SRV, name: "srv-01" },
    },
    port("if", IF_GI20, "Gi1/20", "interface", DIST, "dist-01"),
    {
      id: `dev:${DIST}`,
      type: "device",
      data: { device_id: DIST, name: "dist-01" },
    },
  ],
  edges: [
    membership(PP, `fp:${FP1}`),
    membership(PP, `rp:${RP1}`),
    {
      id: `t:fp:${FP1}:rp:${RP1}`,
      source: `fp:${FP1}`,
      target: `rp:${RP1}`,
      type: "through",
      data: {},
    },
    membership(SRV, `if:${IF_ENO2}`),
    {
      id: `c:${PANEL_CABLE}:fp:${FP1}:if:${IF_ENO2}`,
      source: `fp:${FP1}`,
      target: `if:${IF_ENO2}`,
      type: "cable",
      data: { cable_id: PANEL_CABLE, cable_type: "cat6" },
    },
    membership(DIST, `if:${IF_GI20}`),
    {
      id: `c:${TRUNK}:rp:${RP1}:if:${IF_GI20}`,
      source: `rp:${RP1}`,
      target: `if:${IF_GI20}`,
      type: "cable",
      data: { cable_id: TRUNK, cable_type: "cat6" },
    },
  ],
  device_graph: {
    nodes: [
      card(DIST, "dist-01", role("Distribution", "#f59e0b"), [
        { name: "Gi1/21", kind: "interface" },
        { name: "Gi1/20", kind: "interface" },
      ]),
      card(SRV, "srv-01", role("Server", "#10b981"), [
        { name: "eno2", kind: "interface" },
      ]),
      card(
        PP,
        "pp-01",
        role("Patch panel", "#71717a", true),
        [
          { name: "front2", kind: "front", pair: "rear2" },
          { name: "front1", kind: "front", pair: "rear1" },
        ],
        true
      ),
    ],
    edges: [
      cable(
        SPARE,
        151,
        [DIST, "Gi1/21", "interface"],
        [PP, "rear2", "rear_port"],
        false
      ),
      cable(
        TRUNK,
        149,
        [DIST, "Gi1/20", "interface"],
        [PP, "rear1", "rear_port"],
        true
      ),
      cable(
        PANEL_CABLE,
        148,
        [SRV, "eno2", "interface"],
        [PP, "front1", "front_port"],
        true
      ),
    ],
  },
}

/** The same run traced from the far end's port (dist-01:Gi1/20). */
export const panelTraceFromFar: TraceGraph = {
  ...panelTrace,
  origin: { type: "interface", id: IF_GI20 },
}

/** Ids for the goldens' aliases. */
export const PANEL_IDS: Record<string, string> = {
  [DIST]: "@dist-01",
  [SRV]: "@srv-01",
  [PP]: "@pp-01",
  [PANEL_CABLE]: "@c148",
  [TRUNK]: "@c149",
  [SPARE]: "@c151",
}
