import { describe, expect, it } from "vitest"

import {
  MARKER_TERMINATION_KIND,
  autoArrange,
  composeModuleFaceplates,
  markerTerminationKind,
  type FaceplateDoc,
  type InstalledModuleFaceplate,
} from "./faceplate-layout"

const base = (): FaceplateDoc => ({
  v: 1,
  front: [
    { id: "g1", rows: 1, bank: 0, slots: [{ t: "port", name: "Gi1/0/1" }] },
    {
      id: "bay1",
      bay: "Network Module",
      label: "Network Module",
      rows: 1,
      bank: 0,
      slots: [{ t: "blank" }],
    },
    { id: "g2", rows: 1, bank: 0, slots: [{ t: "port", name: "Gi1/0/2" }] },
  ],
  rear: [],
})

const moduleIn = (
  bay: string,
  position: string,
  faceplate: FaceplateDoc | null
): InstalledModuleFaceplate => ({
  id: "m1",
  module_bay: { name: bay, position },
  module_type_faceplate: faceplate,
})

const moduleFp: FaceplateDoc = {
  v: 1,
  front: [
    {
      id: "mg",
      label: "10G",
      rows: 1,
      bank: 0,
      slots: [{ t: "port", name: "Te1/{module}/1" }],
    },
  ],
  rear: [],
}

describe("composeModuleFaceplates", () => {
  it("returns the base untouched when nothing is installed", () => {
    const doc = base()
    expect(composeModuleFaceplates(doc, [])).toBe(doc)
  })

  it("replaces a placed bay in place with the module's faceplate", () => {
    const out = composeModuleFaceplates(base(), [
      moduleIn("Network Module", "1", moduleFp),
    ])
    // Same length — the placeholder is replaced, not appended.
    expect(out.front).toHaveLength(3)
    expect(out.front.map((g) => g.id)).toEqual(["g1", "mod:m1:mg", "g2"])
    const composed = out.front[1]
    // {module} resolves to the bay position; label is namespaced to the bay.
    expect(composed.slots[0]).toEqual({ t: "port", name: "Te1/1/1" })
    expect(composed.label).toBe("Network Module · 10G")
    expect(composed.bay).toBeUndefined()
  })

  it("keeps the placeholder for an empty bay", () => {
    const out = composeModuleFaceplates(base(), [
      moduleIn("Some Other Bay", "2", moduleFp),
    ])
    // Network Module bay stays as a placeholder; the other module appends.
    expect(out.front.map((g) => g.id)).toEqual([
      "g1",
      "bay1",
      "g2",
      "mod:m1:mg",
    ])
    expect(out.front[1].bay).toBe("Network Module")
  })

  it("keeps the placeholder when a faceplate-less module has no interfaces", () => {
    const out = composeModuleFaceplates(base(), [
      moduleIn("Network Module", "1", null),
    ])
    // Nothing to draw → placeholder retained, module not duplicated.
    expect(out.front.map((g) => g.id)).toEqual(["g1", "bay1", "g2"])
  })

  it("auto-lays a faceplate-less module's interfaces into its bay", () => {
    const m: InstalledModuleFaceplate = {
      id: "m1",
      module_bay: { name: "Network Module", position: "1" },
      module_type_faceplate: null,
      module_interfaces: [
        { name: "Te1/1/1", type: "10gbase-x-sfpp" },
        { name: "Te1/1/2", type: "10gbase-x-sfpp" },
      ],
    }
    const out = composeModuleFaceplates(base(), [m])
    // Placeholder replaced in place (still 3 groups), no trailing append.
    expect(out.front).toHaveLength(3)
    expect(out.front[0].id).toBe("g1")
    expect(out.front[2].id).toBe("g2")
    const composed = out.front[1]
    expect(composed.id).toMatch(/^mod:m1:auto/)
    expect(composed.bay).toBeUndefined()
    const names = composed.slots
      .filter((s) => s.t === "port")
      .map((s) => (s as { name: string }).name)
    expect(names).toEqual(["Te1/1/1", "Te1/1/2"])
  })

  it("honors the bay placeholder's rows/bank for a faceplate-less module", () => {
    // Bay set to 2 rows, banks of 4 in the builder → the auto-laid module must
    // use them (was always one row before).
    const doc: FaceplateDoc = {
      v: 1,
      front: [
        {
          id: "bay1",
          bay: "Network Module",
          label: "Network Module",
          rows: 2,
          bank: 4,
          slots: [{ t: "blank" }],
        },
      ],
      rear: [],
    }
    const m: InstalledModuleFaceplate = {
      id: "m1",
      module_bay: { name: "Network Module", position: "1" },
      module_type_faceplate: null,
      module_interfaces: [
        { name: "Te1/1/1" },
        { name: "Te1/1/2" },
        { name: "Te1/1/3" },
        { name: "Te1/1/4" },
      ],
    }
    const out = composeModuleFaceplates(doc, [m])
    expect(out.front).toHaveLength(1)
    expect(out.front[0].rows).toBe(2)
    expect(out.front[0].bank).toBe(4)
    expect(out.front[0].slots).toHaveLength(4)
  })

  it("appends a module whose bay the layout doesn't place", () => {
    const noBay: FaceplateDoc = {
      v: 1,
      front: [
        { id: "g1", rows: 1, bank: 0, slots: [{ t: "port", name: "Gi1/0/1" }] },
      ],
      rear: [],
    }
    const out = composeModuleFaceplates(noBay, [
      moduleIn("Network Module", "3", moduleFp),
    ])
    expect(out.front.map((g) => g.id)).toEqual(["g1", "mod:m1:mg"])
    expect(out.front[1].slots[0]).toEqual({ t: "port", name: "Te1/3/1" })
  })
})

describe("markerTerminationKind", () => {
  it("maps every cable-able marker kind to its termination kind", () => {
    expect(markerTerminationKind("power-port")).toBe("power_port")
    expect(markerTerminationKind("power-outlet")).toBe("power_outlet")
    expect(markerTerminationKind("console-port")).toBe("console_port")
    expect(markerTerminationKind("console-server-port")).toBe(
      "console_server_port"
    )
    expect(markerTerminationKind("aux-port")).toBe("aux_port")
    expect(markerTerminationKind("front-port")).toBe("front_port")
    expect(markerTerminationKind("rear-port")).toBe("rear_port")
  })

  it("returns null for markers that can't host a cable end", () => {
    // Interface markers link to the interface page instead; hardware and
    // module bays aren't terminations; unknown kinds must stay inert.
    expect(markerTerminationKind("interface")).toBeNull()
    expect(markerTerminationKind("inventory-item")).toBeNull()
    expect(markerTerminationKind("module-bay")).toBeNull()
    expect(markerTerminationKind("")).toBeNull()
    expect(markerTerminationKind("bogus")).toBeNull()
  })

  it("covers exactly the seven non-interface port kinds", () => {
    expect(Object.keys(MARKER_TERMINATION_KIND).sort()).toEqual([
      "aux-port",
      "console-port",
      "console-server-port",
      "front-port",
      "power-outlet",
      "power-port",
      "rear-port",
    ])
  })
})

describe("autoArrange", () => {
  const ports = (prefix: string, n: number, type = "1000base-t") =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i + 1}`,
      name: `${prefix}${i + 1}`,
      type,
    }))

  it("splits front ports to front and rear ports to rear, tagging kind", () => {
    const doc = autoArrange({
      interface: ports("Gi", 4),
      "front-port": ports("Front", 24, "8p8c"),
      "rear-port": ports("Rear", 24, "8p8c"),
    })
    // interfaces + front ports on the front, rear ports on the rear.
    const frontKinds = new Set(
      doc.front.flatMap((g) =>
        g.slots.map((s) => (s.t === "port" ? s.kind : null))
      )
    )
    expect(doc.rear.length).toBeGreaterThan(0)
    // front-port slots carry their kind; interface slots leave it undefined.
    expect(frontKinds.has("front-port")).toBe(true)
    expect(frontKinds.has(undefined)).toBe(true)
    const rearKinds = new Set(
      doc.rear.flatMap((g) =>
        g.slots.map((s) => (s.t === "port" ? s.kind : null))
      )
    )
    expect([...rearKinds]).toEqual(["rear-port"])
  })

  it("honors a forced row count and bank size", () => {
    const doc = autoArrange(
      { "rear-port": ports("Rear", 48, "8p8c") },
      { rows: 4, bank: 6 }
    )
    expect(doc.rear[0].rows).toBe(4)
    expect(doc.rear[0].bank).toBe(6)
  })

  it("restricts to the requested kinds", () => {
    const doc = autoArrange(
      {
        interface: ports("Gi", 4),
        "front-port": ports("Front", 4, "8p8c"),
        "rear-port": ports("Rear", 4, "8p8c"),
      },
      { kinds: ["rear-port"] }
    )
    expect(doc.front).toHaveLength(0)
    expect(doc.rear).toHaveLength(1)
  })
})
