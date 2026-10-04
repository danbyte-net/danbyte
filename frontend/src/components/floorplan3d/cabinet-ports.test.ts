import { describe, expect, it } from "vitest"

import type { ImagePortMarker, ImagePorts } from "@/lib/api"

import { cabinetPosition, parsePortHoverKey, portHoverKey } from "./cabinet-hud"
import { frontMarkers, markersOnBody } from "./cabinet-interior"
import { rackPortPosition } from "./hud-cards"
import type { SceneDevice, SceneTile } from "./world"

// The ports marked on a cabinet device's photo, drawn on it in 3D as the
// room draws a racked device's: which markers its photo carries, which of
// them the body shows, and how a hovered or picked port is named.

const marker = (name: string, x: number, y: number): ImagePortMarker => ({
  kind: "interface",
  name,
  x,
  y,
  w: 0.1,
  h: 0.05,
})

const typePorts: ImagePorts = {
  front: [marker("P1", 0.2, 0.3), marker("P2", 0.4, 0.3)],
  rear: [marker("PSU1", 0.5, 0.5)],
}

describe("frontMarkers", () => {
  it("reads the type's front markers when the device has no layout", () => {
    expect(frontMarkers({ image_ports: null }, typePorts)).toBe(typePorts.front)
  })

  it("lets the device's own layout replace the type's wholesale", () => {
    const own: ImagePorts = { front: [marker("X1", 0.5, 0.5)], rear: [] }
    expect(frontMarkers({ image_ports: own }, typePorts)).toBe(own.front)
    // Even an empty one: the server reads it the same way.
    const empty: ImagePorts = { front: [], rear: [] }
    expect(frontMarkers({ image_ports: empty }, typePorts)).toEqual([])
  })

  it("is nothing before the type has loaded, or with no layout at all", () => {
    expect(frontMarkers({ image_ports: null }, null)).toEqual([])
    expect(frontMarkers({ image_ports: undefined }, undefined)).toEqual([])
  })
})

describe("markersOnBody", () => {
  // A calibrated photo taller than the body: the body shows its middle.
  const body = { x: 140, y: 76.5, width: 60, height: 147 }
  const photo = { x: 140, y: 60, width: 60, height: 180 }

  it("keeps the markers whose middle the body shows", () => {
    const inside = marker("P1", 0.5, 0.5)
    const above = marker("P2", 0.5, 0.05) // 69 mm down: above the body
    const below = marker("P3", 0.5, 0.95) // 231 mm down: below it
    expect(markersOnBody([inside, above, below], photo, body)).toEqual([inside])
  })

  it("hands back the same list when every marker is shown", () => {
    const all = [marker("P1", 0.2, 0.5), marker("P2", 0.8, 0.5)]
    expect(markersOnBody(all, photo, body)).toBe(all)
  })
})

describe("port hover keys", () => {
  it("round-trip a marker name with a slash in it", () => {
    const port = {
      tileId: "t1",
      deviceId: "d1",
      marker: "Ethernet{position}/1",
      kind: "interface",
    }
    expect(parsePortHoverKey(portHoverKey(port))).toEqual(port)
  })

  it("name nothing for anything else", () => {
    expect(parsePortHoverKey("t1/d1")).toBeNull()
    expect(parsePortHoverKey("[1,2,3,4]")).toBeNull()
    expect(parsePortHoverKey('["a","b","c"]')).toBeNull()
  })
})

describe("where a port's card says it is", () => {
  it("in a cabinet: the rail and the offset, as search writes it", () => {
    const d = {
      din_rail: { id: "r2", label: "R2", profile: "ts35" as const },
      din_offset_mm: 120,
    }
    expect(cabinetPosition("K1", d)).toBe("K1 · R2 @ 120 mm")
    expect(cabinetPosition("K1", { din_rail: null, din_offset_mm: null })).toBe(
      "K1"
    )
  })

  it("in a rack: the unit, or the rack alone for a side strip", () => {
    const tile = { rack: { name: "DCT-B03" } } as unknown as SceneTile
    expect(rackPortPosition(tile, { position: 42 } as SceneDevice)).toBe(
      "DCT-B03 · U42"
    )
    expect(rackPortPosition(tile, { position: null } as SceneDevice)).toBe(
      "DCT-B03"
    )
  })
})
