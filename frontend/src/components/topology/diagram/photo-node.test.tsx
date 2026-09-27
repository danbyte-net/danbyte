// @vitest-environment jsdom
import { useLayoutEffect } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider, useStoreApi } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TopoNode } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { CardNode } from "./card-node"
import { PHOTO, photoFace, photoShown } from "./photo-anchors"
import type { FacedData, PhotoShown } from "./photo-anchors"
import type { DiagramCardData } from "./types"

// A photo node on screen: the photo itself with a thin outline on each
// port a cable lands on, grey tabs for ports without a marker, and the
// name as a caption with the pill after it - no card fill. Far out it is a
// plain box; a type with no photo shows its faceplate; neither, the card.

vi.mock("@/components/device-faceplate", () => ({
  TypeFaceplate: ({ deviceTypeId }: { deviceTypeId: string }) => (
    <div data-testid="faceplate">{deviceTypeId}</div>
  ),
}))

afterEach(cleanup)

const base: FacedData = {
  name: "leaf-01",
  device_id: "d1",
  device_type_id: "t1",
  face: "photo",
  role: { name: "Leaf", color: "#6366f1" },
  status_mini: {
    id: "s",
    name: "Planned",
    slug: "planned",
    color: "#0ea5e9",
    text_color: "#ffffff",
  },
  card: { fields: ["status"], source: "default", values: {} },
  photo: {
    front: {
      url: "/media/device-type-images/leaf.png",
      aspect: 0.1,
      scale: null,
      markers: [
        {
          port: "Eth1/1",
          port_id: "p1",
          kind: "interface",
          x: 0.2,
          y: 0.3,
          w: 0.02,
          h: 0.3,
        },
        {
          port: "Eth1/9",
          port_id: "p9",
          kind: "interface",
          x: 0.6,
          y: 0.3,
          w: 0.02,
          h: 0.3,
        },
      ],
    },
    type_faceplate: true,
    u_height: 1,
    vc_position: null,
  },
}

/** The node's data as the build hands it over, with `Eth1/1` cabled and
 * an unmarked port `mgmt0` on a stub lead. */
function photoData(data: FacedData = base): DiagramCardData {
  const face = photoFace(data)!
  const shown: PhotoShown = photoShown(
    face,
    [
      {
        k: "point",
        fx: 0.2,
        fy: (0.3 * face.imgH) / face.h,
        exit: "T",
        port: "Eth1/1",
      },
      { k: "point", fx: 0.5, fy: 0, exit: "T", port: "mgmt0", stub: true },
    ],
    data.name,
    ["Planned"],
    approxMeasure,
    PHOTO.LOD
  )
  return {
    ...(data as TopoNode["data"]),
    diagram: {
      box: {
        w: face.w,
        h: face.h,
        fill: null,
        ink: null,
        title: {
          text: data.name,
          size: 12,
          weight: 700,
          x: 0,
          y: 0,
          top: 0,
          lh: 16,
          anchor: "start",
          w: 0,
        },
        lines: [],
        pill: null,
        stacked: false,
        nubs: { T: 0, R: 0, B: 0, L: 0 },
      },
      nubs: [],
      mode: "detailed",
      photo: shown,
    },
  }
}

function Zoom({ z }: { z: number }) {
  const store = useStoreApi()
  useLayoutEffect(() => {
    store.setState({ transform: [0, 0, z] })
  }, [store, z])
  return null
}

function renderNode(data: DiagramCardData, zoom = 1) {
  const props = { id: "n1", data, selected: false } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <Zoom z={zoom} />
      <CardNode {...props} />
    </ReactFlowProvider>
  )
}

describe("PhotoNode", () => {
  it("draws the photo with its cabled port outlined and the caption", () => {
    const { container } = renderNode(photoData())
    const node = container.querySelector("[data-photo]") as HTMLElement
    expect(node.dataset.photo).toBe("photo")
    expect(node.style.width).toBe(`${PHOTO.W}px`)
    const img = container.querySelector("img")!
    expect(img.getAttribute("src")).toBe("/media/device-type-images/leaf.png")
    // Only the cabled marker - not Eth1/9 - is outlined.
    const marks = container.querySelectorAll(".topo-mark")
    expect([...marks].map((m) => (m as HTMLElement).dataset.port)).toEqual([
      "Eth1/1",
    ])
    // The stub lead for the unmarked port.
    const stub = container.querySelector(".topo-nub") as HTMLElement
    expect(stub.dataset.port).toBe("mgmt0")
    expect(stub.style.top).toBe(`${-6}px`)
    expect(screen.getByText("leaf-01")).toBeTruthy()
    // The pill follows the caption; no card fill, no status dot.
    expect(screen.getByText("Planned")).toBeTruthy()
    expect(node.style.backgroundColor).toBe("")
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("is a plain box far out", () => {
    const { container } = renderNode(photoData(), PHOTO.LOD - 0.05)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector(".topo-photo-lod")).toBeTruthy()
    // The caption and the markers stay.
    expect(screen.getByText("leaf-01")).toBeTruthy()
    expect(container.querySelectorAll(".topo-mark")).toHaveLength(1)
  })

  it("shows the type's faceplate when there is no photo", async () => {
    const data = photoData({
      ...base,
      photo: { ...base.photo!, front: null },
    })
    const { container } = renderNode(data)
    expect(
      (container.querySelector("[data-photo]") as HTMLElement).dataset.photo
    ).toBe("faceplate")
    expect(container.querySelector("img")).toBeNull()
    expect((await screen.findByTestId("faceplate")).textContent).toBe("t1")
  })

  it("stays a card when the node is not a photo", () => {
    const data = photoData()
    const card: DiagramCardData = {
      ...data,
      diagram: {
        ...data.diagram,
        photo: undefined,
        box: { ...data.diagram.box, w: 120, h: 40 },
      },
    }
    const { container } = renderNode(card)
    expect(container.querySelector("[data-photo]")).toBeNull()
    expect(container.querySelector("[data-card]")).toBeTruthy()
  })
})
