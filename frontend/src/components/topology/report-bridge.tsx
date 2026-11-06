import { useEffect, useRef } from "react"

import type { ReportDrawing } from "./export/export-menu"

// Drawing saved views for a bulk topology report, off screen.
//
// The map draws a view only when the map page has loaded it: its saved
// filters, its graph, its layout (in a worker), its photos. Rather than a
// second copy of that pipeline, a bulk report opens each view in the real
// map page, in a hidden same-origin frame at `/topology/map?view=<id>&report=1`.
// There the page's `ReportBridge` waits until the map has drawn and holds
// still, draws it exactly as the map's Export ▸ PDF does (export-menu.tsx
// `reportDrawing`), and posts the drawing to the page that opened the frame.
// `drawSavedView` opens the frame, waits for that message and removes the
// frame. One view at a time, so only one map is ever laid out off screen.

export const REPORT_MESSAGE = "danbyte:topology-report-drawing"

/** How long one view may take to load and settle. */
export const FRAME_TIMEOUT_MS = 90_000
/** How often the bridge looks at the map, and how many looks in a row must
 * agree before the drawing counts as settled. */
const POLL_MS = 400
const STEADY = 3

export interface ReportMessage {
  type: typeof REPORT_MESSAGE
  view: string
  drawing?: ReportDrawing
  error?: string
}

/** The map page's side, in report mode: posts the map's report drawing to
 * the opener once it has drawn and held still. */
export function ReportBridge({
  view,
  ready,
  draw,
}: {
  view: string
  /** The map has its graph. */
  ready: boolean
  draw: () => Promise<ReportDrawing | null>
}) {
  const sent = useRef(false)
  const drawRef = useRef(draw)
  drawRef.current = draw
  useEffect(() => {
    if (!ready || sent.current) return
    let stop = false
    let last = ""
    let same = 0
    const post = (msg: Omit<ReportMessage, "type" | "view">) => {
      if (sent.current) return
      sent.current = true
      window.parent.postMessage(
        { type: REPORT_MESSAGE, view, ...msg },
        window.location.origin
      )
    }
    const started = Date.now()
    const look = async () => {
      if (stop || sent.current) return
      try {
        const d = await drawRef.current()
        // Settled: the same drawing a few looks in a row (the layout and
        // the photos have arrived).
        const key = d ? `${d.devices.length}:${d.drawing.svg.length}` : ""
        same = key && key === last ? same + 1 : 0
        last = key
        if (d && same >= STEADY - 1) return post({ drawing: d })
      } catch (err) {
        return post({ error: err instanceof Error ? err.message : "error" })
      }
      if (Date.now() - started > FRAME_TIMEOUT_MS)
        return post({ error: "The view did not finish drawing." })
      setTimeout(() => void look(), POLL_MS)
    }
    void look()
    return () => {
      stop = true
    }
  }, [ready, view])
  return null
}

/** A saved view drawn off screen in the real map page, as its Export ▸ PDF
 * draws it. Rejects when it does not draw in time. */
export function drawSavedView(
  view: string,
  timeoutMs = FRAME_TIMEOUT_MS
): Promise<ReportDrawing> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    frame.dataset.part = "report-frame"
    // Off screen, at a desktop size so the map lays out as it would there.
    Object.assign(frame.style, {
      position: "fixed",
      left: "-20000px",
      top: "0",
      width: "1600px",
      height: "1000px",
      border: "0",
    })
    const done = () => {
      window.removeEventListener("message", onMessage)
      clearTimeout(timer)
      frame.remove()
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.source !== frame.contentWindow) return
      const msg = e.data as Partial<Record<keyof ReportMessage, unknown>> | null
      if (!msg || msg.type !== REPORT_MESSAGE || msg.view !== view) return
      done()
      if (msg.drawing) resolve(msg.drawing as ReportDrawing)
      else
        reject(
          new Error(
            typeof msg.error === "string"
              ? msg.error
              : "The view could not be drawn."
          )
        )
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error("The view did not finish drawing."))
    }, timeoutMs + 10_000)
    window.addEventListener("message", onMessage)
    frame.src = `/topology/map?view=${encodeURIComponent(view)}&report=1`
    document.body.appendChild(frame)
  })
}
