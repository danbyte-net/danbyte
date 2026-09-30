import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import type { Measure, MeasureKind } from "@/lib/diagram/measure"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type {
  DiagramModel,
  DiagramOptions,
  RelinkOptions,
} from "./build-diagram"
import type { DiagramCardData, Pt } from "./types"

// The Diagram's builder behind a message boundary: what the worker
// (diagram.worker.ts) runs, kept free of worker globals so it can be
// tested in place. It keeps the graph it was last sent and the models it
// built, so a rebuild for new options does not send the graph again and a
// drag sends only where the cards now are.

/** Build options as they cross the boundary: plain data. The search
 * dimming and the focused card are applied by the page - they change no
 * layout. */
export type WireOptions = Omit<
  DiagramOptions,
  "measure" | "matched" | "focusNodeId"
>

/** A model as it crosses the boundary: its measure (a function) stays
 * behind, and the page puts back its own of the same kind. */
export type WireModel = Omit<DiagramModel, "measure">

export type HostRequest =
  | {
      kind: "build"
      id: number
      /** Left out when it is the graph sent last. */
      graph?: TopologyGraph
      opts: WireOptions
    }
  | {
      kind: "relink"
      id: number
      /** The model to re-anchor, as a build reply named it. */
      model: number
      /** Each node's centre: id, x, y. */
      at: [string, number, number][]
      /** What else changed (`RelinkOptions`): the rows' cable sides. */
      over?: RelinkOptions
    }

export type HostReply =
  | {
      kind: "built"
      id: number
      model: number
      nodes: Node[]
      edges: Edge[]
      wire: WireModel
      measure: MeasureKind
      ms: number
    }
  | {
      kind: "relinked"
      id: number
      model: number
      edges: Edge[]
      cards: [string, DiagramCardData["diagram"]][]
      junctions: [string, Pt][]
      /** What each band row's title strip holds now. */
      titles?: [string, [number, number][]][]
      ms: number
    }
  | { kind: "error"; id: number; message: string }

/** Models kept for relinks: the one on screen and a few built since. */
const KEEP = 4

/**
 * A handler for the worker's messages. `measure` is asked once, on the
 * first message: the text measure to lay out with and its kind.
 */
export function diagramHost(
  measure: () => Promise<{ measure: Measure; kind: MeasureKind }>
): (req: HostRequest) => Promise<HostReply> {
  let ready: ReturnType<typeof measure> | null = null
  let graph: TopologyGraph | null = null
  const models = new Map<number, DiagramModel>()
  let made = 0
  return async (req) => {
    const m = await (ready ??= measure())
    const t0 = performance.now()
    try {
      if (req.kind === "build") {
        if (req.graph) graph = req.graph
        if (!graph) throw new Error("no graph to build")
        const built = buildDiagram(graph, { ...req.opts, measure: m.measure })
        const id = ++made
        models.set(id, built.model)
        while (models.size > KEEP) models.delete(models.keys().next().value!)
        const { measure: _drop, ...wire } = built.model
        void _drop
        return {
          kind: "built",
          id: req.id,
          model: id,
          nodes: built.nodes,
          edges: built.edges,
          wire,
          measure: m.kind,
          ms: performance.now() - t0,
        }
      }
      const model = models.get(req.model)
      if (!model) throw new Error(`model ${req.model} is gone`)
      const live = req.at.map(([id, x, y]) => ({
        id,
        position: { x, y },
        data: {},
      }))
      const re = relinkDiagram(model, live, req.over)
      models.set(req.model, re.model)
      return {
        kind: "relinked",
        id: req.id,
        model: req.model,
        edges: re.edges,
        cards: [...re.cards],
        junctions: [...re.junctions],
        ...(re.titles ? { titles: [...re.titles] } : {}),
        ms: performance.now() - t0,
      }
    } catch (e) {
      return {
        kind: "error",
        id: req.id,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }
}
