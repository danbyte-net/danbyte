// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { linkedTile } from "./placement"
import { TileShape } from "./tile-layer"

// A tile shown as its photo draws no coloured outline unless Display >
// Photo outlines asks for one; selected, it is outlined either way.

afterEach(cleanup)

const tile: FloorPlanTile = {
  ...linkedTile(
    {
      kind: "device",
      id: "d1",
      name: "kbh-core1",
      rank: 0,
      room: null,
      location: null,
      status: null,
      role: { id: "r", name: "Core", color: "#ef4444" },
      photo: { url: "/m/a.png", aspect: 0.25, source: "type", width_mm: 440 },
      placed_count: 0,
      placed_on: [],
    },
    { x: 0, y: 0, width: 2, height: 1 },
    "t1",
    "photo"
  ),
}

function outline(props: { selected?: boolean; photoOutline?: boolean }) {
  render(
    <svg>
      <TileShape
        tile={tile}
        selected={!!props.selected}
        editable
        labelFit={false}
        photoOutline={props.photoOutline}
        onPointerDown={() => {}}
        onResizeDown={() => {}}
        onDoubleClick={() => {}}
      />
    </svg>
  )
  return document
    .querySelector('[data-part="photo-outline"]')!
    .getAttribute("stroke")
}

describe("a photo tile's outline", () => {
  it("is off by default", () => {
    expect(outline({})).toBe("none")
  })

  it("shows with Photo outlines", () => {
    expect(outline({ photoOutline: true })).not.toBe("none")
  })

  it("shows while selected, whatever the switch says", () => {
    expect(outline({ selected: true })).not.toBe("none")
  })
})
