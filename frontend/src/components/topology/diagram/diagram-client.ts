import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { measureOf } from "@/lib/diagram/measure"
import type { MeasureKind } from "@/lib/diagram/measure"
import type { DiagramModel } from "./build-diagram"
import type { HostReply, HostRequest, WireOptions } from "./diagram-host"
import type { DiagramCardData, Pt } from "./types"

// The page's side of the Diagram worker (diagram.worker.ts): builds and
// drags go to the worker and come back as promises, so a big map never
// holds the main thread while it is laid out. A browser without workers -
// and the server and tests - build in place instead (`canBuildOffThread`).

/** A build as the page gets it: the model carries this thread's measure of
 * the kind the worker measured with. */
export interface OffThreadBuild {
  nodes: Node[]
  edges: Edge[]
  model: DiagramModel
  /** The worker's name for the model, for its relinks. */
  modelId: number
  measure: MeasureKind
  ms: number
}

/** A relink as the page gets it: the changed cards and junctions. */
export interface OffThreadRelink {
  modelId: number
  edges: Edge[]
  cards: Map<string, DiagramCardData["diagram"]>
  junctions: Map<string, Pt>
  /** What each band row's title strip holds now. */
  titles?: Map<string, [number, number][]>
  ms: number
}

/** Can this page build diagrams in a worker? */
export function canBuildOffThread(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined"
}

/** The least a worker needs to be: what `DiagramWorker` talks to. */
export interface WorkerLike {
  postMessage: (msg: HostRequest) => void
  terminate: () => void
  onmessage: ((e: MessageEvent<HostReply>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

function startWorker(): WorkerLike {
  return new Worker(new URL("./diagram.worker.ts", import.meta.url), {
    type: "module",
    name: "diagram",
  })
}

/**
 * One map's Diagram worker. Builds are coalesced: while one runs, only the
 * newest request waits (the ones it replaced resolve to null). Relinks go
 * in order behind them. A worker that fails rejects everything pending and
 * everything after: the page then builds in place.
 */
export class DiagramWorker {
  private worker: WorkerLike | null = null
  private seq = 0
  private waiting = new Map<number, (reply: HostReply) => void>()
  private failed: Error | null = null
  private sentGraph: TopologyGraph | null = null
  private building = false
  private next: {
    graph: TopologyGraph
    opts: WireOptions
    resolve: (b: OffThreadBuild | null) => void
    reject: (e: Error) => void
  } | null = null

  constructor(private readonly start: () => WorkerLike = startWorker) {}

  private get live(): WorkerLike {
    if (this.failed) throw this.failed
    if (!this.worker) {
      const w = this.start()
      w.onmessage = (e) => {
        const done = this.waiting.get(e.data.id)
        this.waiting.delete(e.data.id)
        done?.(e.data)
      }
      w.onerror = (e) => {
        e.preventDefault()
        this.fail(new Error(e.message || "diagram worker failed"))
      }
      this.worker = w
    }
    return this.worker
  }

  private fail(err: Error) {
    this.failed = err
    this.worker?.terminate()
    this.worker = null
    const error: HostReply = { kind: "error", id: -1, message: err.message }
    for (const done of this.waiting.values()) done(error)
    this.waiting.clear()
    if (this.next) {
      this.next.reject(err)
      this.next = null
    }
  }

  private ask(req: HostRequest): Promise<HostReply> {
    return new Promise((resolve) => {
      this.waiting.set(req.id, resolve)
      try {
        this.live.postMessage(req)
      } catch (e) {
        this.waiting.delete(req.id)
        const err = e instanceof Error ? e : new Error(String(e))
        if (!this.failed) this.fail(err)
        resolve({ kind: "error", id: req.id, message: err.message })
      }
    })
  }

  /** Lay `graph` out; null when a newer build replaced this one before it
   * started. */
  build(
    graph: TopologyGraph,
    opts: WireOptions
  ): Promise<OffThreadBuild | null> {
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      this.next?.resolve(null)
      this.next = { graph, opts, resolve, reject }
      if (!this.building) void this.pump()
    })
  }

  private async pump() {
    while (this.next) {
      const job = this.next
      this.next = null
      this.building = true
      const req: HostRequest = {
        kind: "build",
        id: ++this.seq,
        ...(job.graph !== this.sentGraph ? { graph: job.graph } : {}),
        opts: job.opts,
      }
      this.sentGraph = job.graph
      const reply = await this.ask(req)
      this.building = false
      if (reply.kind === "built") {
        const { wire, measure } = reply
        job.resolve({
          nodes: reply.nodes,
          edges: reply.edges,
          model: { ...wire, measure: measureOf(measure) },
          modelId: reply.model,
          measure,
          ms: reply.ms,
        })
      } else {
        const err = new Error(
          reply.kind === "error" ? reply.message : "unexpected reply"
        )
        // A worker that cannot build is no use for the next one either.
        if (!this.failed) this.fail(err)
        job.reject(err)
      }
    }
  }

  /** Re-anchor model `modelId` for the nodes where they now are. */
  async relink(
    modelId: number,
    nodes: readonly Node[]
  ): Promise<OffThreadRelink> {
    if (this.failed) throw this.failed
    const reply = await this.ask({
      kind: "relink",
      id: ++this.seq,
      model: modelId,
      at: nodes
        .filter((n) => n.type !== "zone")
        .map((n): [string, number, number] => [
          n.id,
          n.position.x,
          n.position.y,
        ]),
    })
    if (reply.kind !== "relinked")
      throw new Error(
        reply.kind === "error" ? reply.message : "unexpected reply"
      )
    return {
      modelId: reply.model,
      edges: reply.edges,
      cards: new Map(reply.cards),
      junctions: new Map(reply.junctions),
      ...(reply.titles ? { titles: new Map(reply.titles) } : {}),
      ms: reply.ms,
    }
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.failed = new Error("diagram worker closed")
    for (const done of this.waiting.values())
      done({ kind: "error", id: -1, message: "closed" })
    this.waiting.clear()
    this.next?.resolve(null)
    this.next = null
  }
}

/** A relinked model as the page keeps it: the cards that changed put in,
 * and what the band titles' strips now hold. */
export function relinkedModel(
  model: DiagramModel,
  cards: ReadonlyMap<string, DiagramCardData["diagram"]>,
  titles?: Map<string, [number, number][]>
): DiagramModel {
  if (!cards.size && !titles) return model
  const shown = new Map(model.shown)
  for (const [id, card] of cards) shown.set(id, card)
  return { ...model, shown, ...(titles ? { titles } : {}) }
}
