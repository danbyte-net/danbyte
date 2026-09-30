import { describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import views from "../__fixtures__/photo-views.json"
import { crosses, crowdedRuns, drawn } from "../__fixtures__/route-checks"
import { buildDiagram } from "./build-diagram"
import { withFaces } from "./photo-anchors"
import type { LineType } from "./types"

// Two photo maps of the demo sites (the whole test view, and one site's
// data centre), drawn every way a photo map can be: the lines may never
// cross more than they did before photo ports learned to leave towards
// their far ends, and cables to a photo's edge never run closer than half
// a lane.
//
// Bendy lines settle on the curve they are drawn with while a card is
// dragged. Between facing ends offset sideways by more than twice the gap
// between them that is an S sweeping out past the middle of the gap, where
// they were squashed to a corner, a level run halfway and a second corner.
// Two such S-curves side by side cross twice where they pass, which two
// level runs did not: dc1-view TB Simple went from 9 crossings to 19 (its
// ceiling rose to match), and test-view TB Detailed from 32 to 40 - its
// old ceiling, which it now sits at with no room to spare. On LR the
// Bendy ceilings fell (test-view Detailed 23 to 21, Simple 31 to 27).
//
// A Bendy line no curve gets clear of the cards no longer goes round them
// as an Elbow: it stays a curve and passes behind them. On test-view LR
// Simple two lines went round; curved, the map crosses 32 times, not 27
// (its ceiling rose to match). On TB Simple three went round, and it
// still crosses 23 times. Every other map is unchanged.

type Key =
  `${"ports" | "edge"}:${"LR" | "TB"}:${"detailed" | "simple"}:${LineType}`

/** The most crossings each way of drawing a map may have. */
const CEILING: Record<string, Partial<Record<Key, number>>> = {
  "test-view": {
    "ports:LR:detailed:elbow": 23,
    "ports:LR:detailed:straight": 26,
    "ports:LR:detailed:bendy": 21,
    "ports:LR:simple:elbow": 25,
    "ports:LR:simple:straight": 28,
    "ports:LR:simple:bendy": 32,
    "ports:TB:detailed:elbow": 21,
    "ports:TB:detailed:straight": 25,
    "ports:TB:detailed:bendy": 40,
    "ports:TB:simple:elbow": 18,
    "ports:TB:simple:straight": 20,
    "ports:TB:simple:bendy": 23,
    "edge:LR:detailed:elbow": 0,
    "edge:LR:simple:elbow": 5,
    "edge:TB:detailed:elbow": 1,
    "edge:TB:simple:elbow": 4,
  },
  "dc1-view": {
    "ports:LR:detailed:elbow": 18,
    "ports:LR:detailed:straight": 17,
    "ports:LR:detailed:bendy": 17,
    "ports:LR:simple:elbow": 16,
    "ports:LR:simple:straight": 15,
    "ports:LR:simple:bendy": 19,
    "ports:TB:detailed:elbow": 14,
    "ports:TB:detailed:straight": 14,
    "ports:TB:detailed:bendy": 16,
    "ports:TB:simple:elbow": 12,
    "ports:TB:simple:straight": 9,
    "ports:TB:simple:bendy": 19,
    "edge:LR:detailed:elbow": 2,
    "edge:LR:simple:elbow": 4,
    "edge:TB:detailed:elbow": 2,
    "edge:TB:simple:elbow": 5,
  },
}

const graphs = views as unknown as Record<string, TopologyGraph>

function crossings(pts: { x: number; y: number }[][]): number {
  let n = 0
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let s = 1; s < pts[i].length; s++)
        for (let t = 1; t < pts[j].length; t++)
          if (crosses(pts[i][s - 1], pts[i][s], pts[j][t - 1], pts[j][t])) n++
  return n
}

describe("photo maps, drawn every way", () => {
  for (const [name, ceilings] of Object.entries(CEILING))
    it(`${name}: no more crossings, and edge cables a lane apart`, () => {
      const g = graphs[name]
      for (const [key, most] of Object.entries(ceilings)) {
        const [anchor, direction, mode, line] = key.split(":") as [
          "ports" | "edge",
          "LR" | "TB",
          "detailed" | "simple",
          LineType,
        ]
        const b = buildDiagram(withFaces(g, "photo", undefined, anchor), {
          mode,
          line,
          colorMode: "cable",
          measure: approxMeasure,
          direction,
        })
        const cables = drawn(b.nodes, b.edges, approxMeasure)
        expect(
          crossings(cables.map((c) => c.pts)),
          `${name} ${key}`
        ).toBeLessThanOrEqual(most)
        if (anchor === "edge")
          expect(crowdedRuns(cables, 6), `${name} ${key}`).toEqual([])
      }
    })
})
