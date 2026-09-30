import { describe, expect, it } from "vitest"

import type { TopologyGraph, TopoPhoto } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { CARD, NUB, PILL } from "./card-layout"
import {
  captionPill,
  captionRoom,
  captionTail,
  exitTowards,
  faceOf,
  markerOf,
  PHOTO,
  photoAnchors,
  photoFace,
  photoLod,
  photoShown,
  wantsPhotos,
  withFaces,
} from "./photo-anchors"
import type { FacedData, PhotoLink } from "./photo-anchors"
import type { Rect } from "./types"

// A device drawn as its front photo: the photo to scale, each cable on the
// marker of the port it is plugged into (joined by the component, then by
// name), a stub lead on the image edge for a port without one, and the
// name under the image, clear of the leads running down through it.

const marker = (
  port: string,
  x: number,
  y: number,
  extra: Partial<NonNullable<TopoPhoto["front"]>["markers"][number]> = {}
) => ({
  port,
  port_id: `id-${port}`,
  kind: "interface",
  x,
  y,
  w: 0.02,
  h: 0.3,
  ...extra,
})

function photoData(
  photo: Partial<TopoPhoto> = {},
  extra: Partial<FacedData> = {}
): FacedData {
  return {
    name: "leaf-01",
    device_id: "d1",
    device_type_id: "t1",
    face: "photo",
    photo: {
      front: {
        url: "/media/device-type-images/leaf.png",
        aspect: 0.1,
        scale: null,
        markers: [
          marker("Eth1/1", 0.2, 0.3),
          marker("Eth1/2", 0.2, 0.7),
          marker("1", 0.8, 0.3, { port_id: "fp-1", kind: "front-port" }),
        ],
      },
      type_faceplate: true,
      u_height: 1,
      vc_position: null,
      ...photo,
    },
    ...extra,
  }
}

const face = () => photoFace(photoData())!

describe("photoFace", () => {
  it("draws a marked device's photo to scale, its caption underneath", () => {
    const f = face()
    expect(f.kind).toBe("photo")
    expect(f.w).toBe(PHOTO.W)
    expect(f.imgH).toBe(48)
    expect(f.h).toBe(48 + PHOTO.CAPTION_GAP + PHOTO.CAPTION_LH)
    expect(f.marks.map((m) => [m.port, m.kind])).toEqual([
      ["Eth1/1", "interface"],
      ["Eth1/2", "interface"],
      ["1", "front_port"],
    ])
  })

  it("halves a half-width type", () => {
    const f = photoFace(photoData({ rack_width: "half" }))!
    expect(f.w).toBe(PHOTO.W / 2)
    expect(f.imgH).toBe(24)
  })

  it("sizes an unreadable photo by its rack units", () => {
    const f = photoFace(
      photoData({
        u_height: 2,
        front: { url: "/x.png", aspect: null, scale: null, markers: [] },
      })
    )!
    expect(f.imgH).toBe(Math.round((2 * PHOTO.W * PHOTO.U_MM) / PHOTO.RACK_MM))
  })

  it("falls back to the faceplate, then to the card", () => {
    const plate = photoFace(photoData({ front: null }))!
    expect(plate.kind).toBe("faceplate")
    expect(plate.typeId).toBe("t1")
    expect(plate.marks).toEqual([])
    expect(
      photoFace(photoData({ front: null, type_faceplate: false }))
    ).toBeNull()
    expect(photoFace(photoData({}, { face: undefined }))).toBeNull()
    expect(photoFace({ ...photoData(), photo: undefined })).toBeNull()
  })

  it("skips a marker with a box outside the image", () => {
    const f = photoFace(
      photoData({
        front: {
          url: "/x.png",
          aspect: 0.1,
          scale: null,
          markers: [marker("bad", 1.4, 0.5), marker("ok", 0.5, 0.5)],
        },
      })
    )!
    expect(f.marks.map((m) => m.port)).toEqual(["ok"])
  })
})

describe("markerOf", () => {
  it("joins by the component, mapping the marker kind to the pair's", () => {
    const f = face()
    expect(
      markerOf(f, "whatever", { id: "id-Eth1/2", kind: "interface" })
    ).toBe(1)
    // Marker kind `front-port` is the pair's `front_port`.
    expect(markerOf(f, undefined, { id: "fp-1", kind: "front_port" })).toBe(2)
    // No kind on the pair: the id alone.
    expect(markerOf(f, undefined, { id: "fp-1" })).toBe(2)
  })

  it("falls back to the port name, exact then loose", () => {
    const f = face()
    expect(markerOf(f, "Eth1/1")).toBe(0)
    expect(markerOf(f, " eth1/1 ")).toBe(0)
    expect(markerOf(f, "Eth9/9")).toBeUndefined()
  })

  it("never lands a name on a marker of another kind", () => {
    const f = face()
    // Port "1" is a front port; an interface called "1" is not it.
    expect(markerOf(f, "1", { id: "other", kind: "interface" })).toBeUndefined()
    expect(markerOf(f, "1", { id: "other", kind: "front_port" })).toBe(2)
  })
})

const rects = (entries: [string, Rect][]) => new Map(entries)

describe("photoAnchors", () => {
  const f = face()
  const photos = new Map([["P", f]])
  const boxes = rects([
    ["P", { x: 0, y: 200, w: f.w, h: f.h }],
    ["up", { x: 100, y: 0, w: 100, h: 40 }],
    ["down", { x: 300, y: 500, w: 100, h: 40 }],
    ["down2", { x: 0, y: 500, w: 100, h: 40 }],
  ])

  it("puts a marked port's cable on its marker, out of the nearer edge", () => {
    const links: PhotoLink[] = [
      {
        id: "l1",
        source: "P",
        target: "up",
        cables: [
          { a: "Eth1/1", aRef: { id: "id-Eth1/1", kind: "interface" } },
          { a: "Eth1/2", aRef: { id: "id-Eth1/2", kind: "interface" } },
        ],
      },
    ]
    const out = photoAnchors(photos, boxes, links)
    expect(out.get("l1#0a")).toEqual({
      k: "point",
      fx: 0.2,
      fy: (0.3 * f.imgH) / f.h,
      exit: "T",
      port: "Eth1/1",
    })
    // The bottom row leaves downwards, whatever the far end.
    expect(out.get("l1#1a")?.exit).toBe("B")
    expect(out.has("l1#0b")).toBe(false)
  })

  it("leaves towards a far end above or below, over the photo", () => {
    const at = (links: PhotoLink[]) => photoAnchors(photos, boxes, links)
    const one = (port: string, to: string, end: "a" | "b" = "a") =>
      at([
        end === "a"
          ? { id: "x", source: "P", target: to, cables: [{ a: port }] }
          : { id: "x", source: to, target: "P", cables: [{ b: port }] },
      ]).get(`x#0${end}`)?.exit
    // The bottom row up to a device above; the top row down to one below.
    expect(one("Eth1/2", "up")).toBe("T")
    expect(one("Eth1/1", "down", "b")).toBe("B")
    // Level with the photo: the nearer edge.
    const level = new Map(boxes).set("side", { x: 900, y: 190, w: 80, h: 40 })
    const out = photoAnchors(photos, level, [
      { id: "s", source: "P", target: "side", cables: [{ a: "Eth1/1" }] },
      { id: "t", source: "P", target: "side", cables: [{ a: "Eth1/2" }] },
    ])
    expect(out.get("s#0a")?.exit).toBe("T")
    expect(out.get("t#0a")?.exit).toBe("B")
  })

  it("never runs a lead over another cabled port in its column", () => {
    // Both rows cabled down: the top row's lead would run over the bottom
    // row's port, so it keeps to the top edge.
    const out = photoAnchors(photos, boxes, [
      {
        id: "d",
        source: "P",
        target: "down",
        cables: [{ a: "Eth1/1" }, { a: "Eth1/2" }],
      },
    ])
    expect(out.get("d#0a")?.exit).toBe("T")
    expect(out.get("d#1a")?.exit).toBe("B")
  })

  it("picks the exit from the boxes, the nearer edge without them", () => {
    const me: Rect = { x: 0, y: 100, w: 480, h: 60 }
    expect(exitTowards(me, { x: 0, y: 0, w: 10, h: 100 }, 0.9)).toBe("T")
    expect(exitTowards(me, { x: 0, y: 160, w: 10, h: 10 }, 0.1)).toBe("B")
    expect(exitTowards(me, { x: 600, y: 150, w: 10, h: 40 }, 0.9)).toBe("B")
    expect(exitTowards(me, undefined, 0.2)).toBe("T")
  })

  it("lands an unmarked port on a stub lead facing its far end", () => {
    const links: PhotoLink[] = [
      { id: "a", source: "P", target: "up", cables: [{ a: "mgmt0" }] },
      { id: "b", source: "down", target: "P", cables: [{ b: "eth9" }] },
      { id: "c", source: "P", target: "down2", cables: [{ a: "eth8" }] },
    ]
    const out = photoAnchors(photos, boxes, links)
    const up = out.get("a#0a")!
    expect(up).toMatchObject({ exit: "T", fy: 0, stub: true, port: "mgmt0" })
    expect(up.fx).toBeCloseTo(0.5)
    // Two on the bottom edge: a nub pitch apart, the far-left one first.
    const b = out.get("b#0b")!
    const c = out.get("c#0a")!
    expect(b).toMatchObject({ exit: "B", fy: f.imgH / f.h, stub: true })
    expect(c.fx * f.w).toBeCloseTo(f.w / 2 - NUB.PITCH / 2)
    expect(b.fx * f.w).toBeCloseTo(f.w / 2 + NUB.PITCH / 2)
  })

  it("leaves links without ports, and junction ends, alone", () => {
    const out = photoAnchors(photos, boxes, [
      { id: "ghost", source: "P", target: "up" },
      {
        id: "trunk",
        source: "fan",
        target: "P",
        cables: [{ b: "Eth1/1" }],
        junction: { a: [1, 0] },
      },
      {
        id: "leg",
        source: "P",
        target: "fan",
        cables: [{ a: "Eth1/2" }],
        junction: { b: [1, 0] },
      },
    ])
    expect([...out.keys()].sort()).toEqual(["leg#0a", "trunk#0b"])
  })
})

describe("captionRoom", () => {
  it("stays at the left when it fits there", () => {
    expect(captionRoom(480, [[300, 320]], 120)).toEqual({
      x: 0,
      room: 120,
      to: 300,
    })
  })

  it("steps into the first gap between the leads it fits", () => {
    expect(
      captionRoom(
        480,
        [
          [20, 40],
          [100, 120],
        ],
        60
      )
    ).toEqual({ x: 40, room: 60, to: 100 })
  })

  it("takes the widest gap, cut, when none fits", () => {
    expect(
      captionRoom(
        480,
        [
          [50, 60],
          [130, 480],
        ],
        200
      )
    ).toEqual({ x: 60, room: 70, to: 130 })
  })

  it("keeps the left when every gap is too small to read", () => {
    expect(
      captionRoom(
        100,
        [
          [10, 40],
          [60, 100],
        ],
        200
      )
    ).toEqual({ x: 0, room: 100, to: 100 })
  })
})

describe("photoShown", () => {
  const f = face()

  it("outlines only the markers a line lands on, and places the stubs", () => {
    const shown = photoShown(
      f,
      [
        {
          k: "point",
          fx: 0.2,
          fy: (0.3 * f.imgH) / f.h,
          exit: "T",
          port: "Eth1/1",
        },
        { k: "point", fx: 0.5, fy: 0, exit: "T", port: "mgmt0", stub: true },
        { k: "side", side: "L", off: 3 },
      ],
      "leaf-01",
      [],
      approxMeasure
    )
    expect(shown.marks.map((m) => m.port)).toEqual(["Eth1/1"])
    expect(shown.stubs).toEqual([{ port: "mgmt0", x: 240, side: "T" }])
    expect(shown.url).toBe("/media/device-type-images/leaf.png")
    expect(shown.lod).toBe(PHOTO.LOD)
  })

  it("puts the caption under the image, clear of the leads going down", () => {
    const name = "a-long-device-name-01"
    const down = (fx: number) => ({
      k: "point" as const,
      fx,
      fy: (0.7 * f.imgH) / f.h,
      exit: "B" as const,
      port: "p",
    })
    const shown = photoShown(
      f,
      [down(0.05), down(0.1)],
      name,
      [],
      approxMeasure
    )
    const cap = shown.caption
    expect(cap.top).toBe(f.imgH + PHOTO.CAPTION_GAP)
    expect(cap.text).toBe(name)
    // Right of the second lead (at 48 px) and its clearance.
    expect(cap.x).toBeGreaterThanOrEqual(48 + NUB.ALONG / 2)
    const w = approxMeasure(name, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)
    expect(cap.w).toBe(Math.ceil(w))
  })
})

describe("caption card lines", () => {
  // Every character half its font size wide: 6 px a name character, 5 px
  // a line character.
  const mono: Measure = (t, size) => (Array.from(t).length * size) / 2
  const f = face()
  const down = (x: number) => ({
    k: "point" as const,
    fx: x / f.w,
    fy: (0.7 * f.imgH) / f.h,
    exit: "B" as const,
    port: "p",
  })
  const lines = ["10.0.0.1", "SN FOC1234"]
  const shown = (ends: ReturnType<typeof down>[], slot: string[] = []) =>
    photoShown(f, ends, "leaf-01", slot, mono, PHOTO.LOD, lines).caption

  it("puts the lines after the name, the pill after them", () => {
    const cap = shown([], ["Planned"])
    expect(cap.text).toBe("leaf-01")
    expect([cap.x, cap.w]).toEqual([0, 42])
    expect(cap.tail).toEqual({
      text: "· 10.0.0.1 · SN FOC1234",
      x: 42 + PHOTO.TAIL_GAP,
      w: 115,
    })
    expect(cap.full).toBeUndefined()
    // The pill follows the lines, not the name.
    expect(captionPill(cap, 46).x).toBe(46 + 115 + PILL.GAP)
  })

  it("takes the first gap the whole caption fits", () => {
    // A lead at 120 px leaves room at the left for the name and pill, not
    // for the lines: the caption steps past it, the name with them.
    const cap = shown([down(120)], ["Planned"])
    expect(cap.x).toBe(120 + NUB.ALONG / 2 + PHOTO.CAPTION_PAD)
    expect(cap.tail?.text).toBe("· 10.0.0.1 · SN FOC1234")
  })

  it("keeps whole values only, and says some are left off", () => {
    // No gap takes the whole caption; the first takes the name and 93 px.
    const cap = shown([down(150), down(290), down(400)])
    expect(cap.x).toBe(0)
    expect(cap.tail?.text).toBe("· 10.0.0.1 · …")
    expect(cap.full).toBe("leaf-01 · 10.0.0.1 · SN FOC1234")
  })

  it("steps on to a gap that holds some of the lines whole", () => {
    // Only the last gap (311-480 px) takes the name, one line and the pill.
    const cap = shown([down(120), down(300)], ["Planned"])
    expect(cap.x).toBe(300 + NUB.ALONG / 2 + PHOTO.CAPTION_PAD)
    expect(cap.tail?.text).toBe("· 10.0.0.1 · …")
    expect(cap.full).toBe("leaf-01 · 10.0.0.1 · SN FOC1234")
  })

  it("leaves the lines off where there is no room to read them", () => {
    const cap = shown([down(120), down(300), down(420)], ["Planned"])
    expect(cap.x).toBe(0)
    expect(cap.text).toBe("leaf-01")
    expect(cap.tail).toBeUndefined()
    expect(cap.full).toBe("leaf-01 · 10.0.0.1 · SN FOC1234")
    expect(captionPill(cap, 46).x).toBe(42 + PILL.GAP)
  })

  it("names only the name when that is all it cut", () => {
    const long = "x".repeat(100)
    const cap = photoShown(f, [], long, [], mono).caption
    expect(cap.text.endsWith("…")).toBe(true)
    expect(cap.tail).toBeUndefined()
    expect(cap.full).toBe(long)
    expect(photoShown(f, [], "leaf-01", [], mono).caption.full).toBeUndefined()
  })

  it("cuts only a first value too long to fit whole", () => {
    expect(captionTail(["10.100.200.250"], 50, mono)).toEqual({
      text: "· 10.100.…",
      w: 50,
      cut: true,
    })
    expect(captionTail(["10.0.0.1", "SN X"], 200, mono)).toEqual({
      text: "· 10.0.0.1 · SN X",
      w: 85,
      cut: false,
    })
    expect(captionTail([], 200, mono)).toBeNull()
    expect(captionTail(["10.0.0.1"], PHOTO.TAIL_MIN - 1, mono)).toBeNull()
  })

  it("reads a rack line as one value", () => {
    const cap = photoShown(f, [], "leaf-01", [], mono, PHOTO.LOD, [
      "Rack R1 · U12",
    ]).caption
    expect(cap.tail?.text).toBe("· Rack R1 U12")
  })
})

describe("photoLod", () => {
  it("keeps a small map's photos down to a far zoom", () => {
    expect(photoLod(8)).toBe(PHOTO.LOD_FEW)
    expect(photoLod(PHOTO.MANY)).toBe(PHOTO.LOD)
  })
})

describe("faces", () => {
  const graph: TopologyGraph = {
    nodes: [
      { id: "dev:a", type: "device", data: { name: "a", device_id: "a" } },
      { id: "dev:b", type: "device", data: { name: "b", device_id: "b" } },
      { id: "fp:1", type: "front_port", data: { name: "1" } },
    ],
    edges: [],
  }
  const marked = (g: TopologyGraph) =>
    g.nodes
      .filter((n) => (n.data as FacedData).face === "photo")
      .map((n) => n.id)

  it("marks what the view shows as photos, a device's own face first", () => {
    expect(marked(withFaces(graph, "photo"))).toEqual(["dev:a", "dev:b"])
    expect(marked(withFaces(graph, "photo", { b: { face: "card" } }))).toEqual([
      "dev:a",
    ])
    expect(marked(withFaces(graph, "card", { b: { face: "photo" } }))).toEqual([
      "dev:b",
    ])
  })

  it("hands back the same graph when nothing changes", () => {
    expect(withFaces(graph, "card")).toBe(graph)
    const photos = withFaces(graph, "photo")
    expect(withFaces(photos, "photo")).toBe(photos)
    expect(marked(withFaces(photos, "card"))).toEqual([])
  })

  it("asks for photos only when some device wants one", () => {
    expect(wantsPhotos("card")).toBe(false)
    expect(wantsPhotos("card", { a: { face: "card" } })).toBe(false)
    expect(wantsPhotos("card", { a: { face: "photo" } })).toBe(true)
    expect(wantsPhotos("photo")).toBe(true)
    expect(faceOf("a", "card", { a: { face: "photo" } })).toBe("photo")
    expect(faceOf(undefined, "card", { a: { face: "photo" } })).toBe("card")
  })
})
