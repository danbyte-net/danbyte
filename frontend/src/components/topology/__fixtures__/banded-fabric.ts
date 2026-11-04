import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"

// A layered fabric for the band arrangement (Arrange ▸ Bands by role): two
// CE routers, four spines, eight leafs and twelve compute nodes, every
// spine cabled to every leaf from adjacent ports along its bottom edge, a
// /31 and a /127 on each point-to-point link - the tall spine/leaf gap full
// of cables the Bendy line has to cross.

const ROLES = {
  ce: { name: "CE", color: "#f97316" },
  spine: { name: "Spine", color: "#6366f1" },
  leaf: { name: "Leaf", color: "#0ea5e9" },
  compute: { name: "Compute", color: "#10b981" },
} as const

type Role = keyof typeof ROLES

export function bandedFabric(): TopologyGraph {
  const nodes: TopoNode[] = []
  const edges: TopoEdge[] = []
  const device = (name: string, role: Role) => {
    const id = `dev:${name}`
    nodes.push({
      id,
      type: "device",
      data: {
        name,
        device_id: name,
        role: ROLES[role],
        primary_ip: `10.0.${nodes.length}.1`,
      },
    })
    return id
  }
  let n = 0
  const cable = (a: string, ap: string, b: string, bp: string) => {
    n++
    const v4 = `10.242.${n >> 7}.${(n * 2) & 255}`
    const v4b = `10.242.${n >> 7}.${((n * 2) & 255) + 1}`
    const v6 = `fd36:2c1::${(n * 2).toString(16)}`
    const v6b = `fd36:2c1::${(n * 2 + 1).toString(16)}`
    edges.push({
      id: `c${n}`,
      source: a,
      target: b,
      type: "cable",
      data: {
        cable_id: `c${n}`,
        cable_type: "cat6",
        status: "connected",
        pairs: [
          {
            a: `${a}:${ap}`,
            b: `${b}:${bp}`,
            a_port: ap,
            b_port: bp,
            a_ips: [`${v4}/31`, `${v6}/127`],
            b_ips: [`${v4b}/31`, `${v6b}/127`],
            subnets: [
              { cidr: `${v4}/31`, family: 4, a: v4, b: v4b },
              { cidr: `${v6}/127`, family: 6, a: v6, b: v6b },
            ],
          },
        ],
        subnets: [`${v4}/31`, `${v6}/127`],
      },
    })
  }
  const ces = [1, 2].map((i) => device(`ce-${i}`, "ce"))
  const spines = [1, 2, 3, 4].map((i) => device(`spine-${i}`, "spine"))
  const leafs = Array.from({ length: 8 }, (_, i) =>
    device(`leaf-${i + 1}`, "leaf")
  )
  const computes = Array.from({ length: 12 }, (_, i) =>
    device(`compute-${i + 1}`, "compute")
  )
  ces.forEach((ce, i) =>
    spines.forEach((s, k) =>
      cable(ce, `Ethernet0/${k + 1}`, s, `Ethernet2/${i + 1}`)
    )
  )
  spines.forEach((s, k) =>
    leafs.forEach((l, i) =>
      cable(s, `Ethernet1/${i + 1}`, l, `Ethernet1/${49 + k}`)
    )
  )
  computes.forEach((c, i) => {
    cable(leafs[i % 8], `Ethernet1/${1 + Math.floor(i / 8)}`, c, "eno1")
    if (i < 4) cable(leafs[(i + 1) % 8], `Ethernet1/${3 + i}`, c, "eno2")
  })
  return { nodes, edges }
}
