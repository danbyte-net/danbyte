import { approxMeasure } from "@/lib/diagram/measure"
import { offscreenMeasure } from "@/lib/diagram/offscreen-measure"
import { diagramHost } from "./diagram-host"
import type { HostRequest } from "./diagram-host"

// The Diagram's layout and link planning, off the page's main thread
// (diagram-client.ts starts it). Text is measured with Inter on an
// OffscreenCanvas when the worker can load it, else with Inter's width
// table; each reply says which.

const handle = diagramHost(async () => {
  const measure = await offscreenMeasure()
  return measure
    ? { measure, kind: "canvas" as const }
    : { measure: approxMeasure, kind: "approx" as const }
})

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<HostRequest>) => void) | null
  postMessage: (msg: unknown) => void
}

scope.onmessage = (e) => {
  void handle(e.data).then((reply) => scope.postMessage(reply))
}
