import { describe, expect, it } from "vitest"

import {
  composeModuleFaceplates,
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
