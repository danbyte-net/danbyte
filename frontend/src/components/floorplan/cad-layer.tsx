import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  FloorPlanDrawing,
  FloorPlanDrawingPlacement,
  FloorPlanDrawingRender,
} from "@/lib/api"

import { canvasTransform, wantsServerRender } from "./cad-math"

// A plan's CAD drawing on the 2D canvas: the sanitised SVG the worker
// rendered (api/cad_render.py), placed under the grid at true scale. Small
// drawings are inlined so layers toggle instantly; above the element budget
// the canvas shows a server render with the hidden layers already left out,
// as one image.

const SVG_NS = "http://www.w3.org/2000/svg"

/** Elements and attributes that never belong in a CAD render. The server's
 * sanitiser already strips them; this is a second fence at the DOM. */
const BANNED = new Set([
  "script",
  "foreignobject",
  "iframe",
  "image",
  "use",
  "a",
  "style",
  "animate",
  "set",
  "animatemotion",
  "animatetransform",
])

/** Parse the rendered SVG text. Refuses anything whose root is not an
 * `<svg>` in the SVG namespace, or that does not parse. Strips scripts,
 * links, event handlers and external references on the way. */
export function parseCadSvg(text: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml")
  const root = doc.documentElement
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== SVG_NS ||
    doc.getElementsByTagName("parsererror").length > 0
  )
    throw new Error("Not an SVG drawing")
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (BANNED.has(child.localName.toLowerCase())) {
        child.remove()
        continue
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        if (
          name.startsWith("on") ||
          name === "href" ||
          name === "xlink:href" ||
          name === "style" ||
          /url\s*\(/i.test(attr.value)
        )
          child.removeAttribute(attr.name)
      }
      walk(child)
    }
  }
  walk(root)
  return root as unknown as SVGSVGElement
}

/** Lineweights arrive in drawing millimetres and the layer draws with
 * `vector-effect: non-scaling-stroke`, so a width becomes screen pixels:
 * keep them readable without losing the heavy/light difference. */
export function normaliseStrokes(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("[stroke-width]"))) {
    const w = parseFloat(el.getAttribute("stroke-width") ?? "")
    const px = Number.isFinite(w) ? Math.min(3, Math.max(0.75, w * 2)) : 1
    el.setAttribute("stroke-width", String(px))
  }
}

/** Hide layers (`g[data-layer]`) by name and, with `hideText`, every
 * `[data-kind=text]` group. Matches by attribute value, so a layer name
 * with quotes or brackets needs no selector escaping. */
export function applyLayerVisibility(
  root: Element,
  hidden: Iterable<string>,
  hideText: boolean
): void {
  const off = new Set(hidden)
  for (const g of Array.from(root.querySelectorAll("g[data-layer]"))) {
    const name = g.getAttribute("data-layer") ?? ""
    if (off.has(name)) g.setAttribute("display", "none")
    else g.removeAttribute("display")
  }
  for (const g of Array.from(root.querySelectorAll('g[data-kind="text"]'))) {
    if (hideText) g.setAttribute("display", "none")
    else g.removeAttribute("display")
  }
}

/** The visible drawing as standalone SVG text: hidden layers removed, the
 * root sized `px` (for rasterising into a texture). `strokeScale` turns the
 * normalised screen-pixel stroke widths into drawing units at that size -
 * a raster has no non-scaling strokes. */
export function visibleSvgText(
  root: SVGSVGElement,
  hidden: Iterable<string>,
  hideText: boolean,
  px: { width: number; height: number },
  strokeScale = 1
): string {
  const copy = root.cloneNode(true) as SVGSVGElement
  applyLayerVisibility(copy, hidden, hideText)
  for (const g of Array.from(copy.querySelectorAll('g[display="none"]')))
    g.remove()
  if (strokeScale !== 1)
    for (const el of Array.from(copy.querySelectorAll("[stroke-width]"))) {
      const w = parseFloat(el.getAttribute("stroke-width") ?? "")
      if (Number.isFinite(w))
        el.setAttribute("stroke-width", String(w * strokeScale))
    }
  copy.setAttribute("width", String(px.width))
  copy.setAttribute("height", String(px.height))
  copy.setAttribute("preserveAspectRatio", "none")
  return new XMLSerializer().serializeToString(copy)
}

/** Fetch the rendered SVG once per plan and render: same-origin media, the
 * session cookie authorises it. Keyed by the file and when it was made, not
 * the record's updated_at, so a placement change does not refetch it. */
export function useCadSvgText(
  planId: string,
  drawing: Pick<FloorPlanDrawing, "rendered_url" | "processed_at"> | null,
  enabled = true
) {
  const url = drawing?.rendered_url ?? null
  return useQuery({
    queryKey: ["floor-plan-drawing-svg", planId, url, drawing?.processed_at],
    enabled: enabled && !!url,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(url!, { credentials: "same-origin" })
      if (!res.ok) throw new Error(`Drawing ${res.status}`)
      return res.text()
    },
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A server render with `hidden` left out: POST, then poll by key until it
 * is ready or failed. */
export async function fetchServerRender(
  planId: string,
  hidden: string[],
  hideText: boolean,
  { interval = 1500, tries = 200 } = {}
): Promise<FloorPlanDrawingRender> {
  let r = await api<FloorPlanDrawingRender>(
    `/api/floor-plans/${planId}/drawing/render/`,
    {
      method: "POST",
      body: JSON.stringify({ hidden_layers: hidden, hide_text: hideText }),
    }
  )
  for (let i = 0; r.status === "queued" && i < tries; i++) {
    await sleep(interval)
    r = await api<FloorPlanDrawingRender>(
      `/api/floor-plans/${planId}/drawing/render/?key=${encodeURIComponent(r.key)}`
    )
  }
  return r
}

export interface CadSource {
  /** "inline": `svg` is the parsed drawing; "image": `imageUrl` is drawn
   * as one picture (a server render, layers already left out). */
  mode: "inline" | "image"
  svg: SVGSVGElement | null
  imageUrl: string | null
  loading: boolean
  error: string | null
}

/**
 * Where the canvas gets the drawing from. Inline below the element budget;
 * above it, the rendered file itself while nothing is hidden, else a server
 * render with the hidden set applied.
 */
export function useCadSource(
  planId: string,
  drawing: FloorPlanDrawing | null,
  placement: Pick<FloorPlanDrawingPlacement, "hidden_layers" | "hide_text">,
  budget?: number
): CadSource {
  const ready = drawing?.status === "ready" && !!drawing.rendered_url
  const big = !!drawing && wantsServerRender(drawing, budget)
  const hidden = useMemo(
    () => [...placement.hidden_layers].sort(),
    [placement.hidden_layers]
  )
  const filtered = hidden.length > 0 || placement.hide_text
  const text = useCadSvgText(planId, drawing, ready && !big)
  const render = useQuery({
    queryKey: [
      "floor-plan-drawing-render",
      planId,
      drawing?.processed_at,
      hidden,
      placement.hide_text,
    ],
    enabled: ready && big && filtered,
    staleTime: Infinity,
    queryFn: () => fetchServerRender(planId, hidden, placement.hide_text),
  })
  const svg = useMemo(() => {
    if (!text.data) return null
    try {
      const root = parseCadSvg(text.data)
      normaliseStrokes(root)
      return root
    } catch {
      return null
    }
  }, [text.data])

  if (!ready) {
    return {
      mode: "inline",
      svg: null,
      imageUrl: null,
      loading: false,
      error: null,
    }
  }
  if (!big) {
    return {
      mode: "inline",
      svg,
      imageUrl: null,
      loading: text.isLoading,
      error: text.isError
        ? "The drawing could not be loaded."
        : text.data && !svg
          ? "The drawing is not a valid SVG."
          : null,
    }
  }
  if (!filtered) {
    return {
      mode: "image",
      svg: null,
      imageUrl: drawing.rendered_url,
      loading: false,
      error: null,
    }
  }
  const r = render.data
  return {
    mode: "image",
    svg: null,
    imageUrl: r?.status === "ready" ? r.url : null,
    loading: render.isLoading || r?.status === "queued",
    error: render.isError
      ? "The drawing could not be rendered."
      : r?.status === "failed"
        ? r.error || "The drawing could not be rendered."
        : null,
  }
}

/** Longest side of the 3D floor texture, in pixels. 4096 is the texture
 * size every WebGL device the 3D view supports takes. */
export const FLOOR_TEXTURE_PX = 4096

/** Pixel size for a drawing rasterised at most `max` on its long side. */
export function rasterSize(
  size: { width: number; height: number },
  max = FLOOR_TEXTURE_PX
): { width: number; height: number } {
  const k = max / Math.max(size.width, size.height, 1e-9)
  return {
    width: Math.max(1, Math.round(size.width * k)),
    height: Math.max(1, Math.round(size.height * k)),
  }
}

/** Rasterise standalone SVG text to a PNG object URL, the way the PNG
 * export draws the plan: an <img> of the SVG painted onto a canvas. */
async function rasterise(
  svgText: string,
  px: { width: number; height: number }
): Promise<string> {
  const src = URL.createObjectURL(
    new Blob([svgText], { type: "image/svg+xml" })
  )
  try {
    const img = new Image()
    img.decoding = "async"
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error("Drawing raster failed"))
      img.src = src
    })
    const canvas = document.createElement("canvas")
    canvas.width = px.width
    canvas.height = px.height
    canvas.getContext("2d")!.drawImage(img, 0, 0, px.width, px.height)
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, "image/png")
    )
    if (!blob) throw new Error("Drawing raster failed")
    return URL.createObjectURL(blob)
  } finally {
    URL.revokeObjectURL(src)
  }
}

/**
 * The visible drawing as a PNG for the 3D room's floor - hidden layers and
 * text left out as on the 2D plan. Only works while `enabled` (the 3D view
 * is open); the URL is revoked when it changes or the view closes.
 */
export function useCadFloorImage(
  drawing: FloorPlanDrawing | null,
  source: CadSource,
  placement: Pick<FloorPlanDrawingPlacement, "hidden_layers" | "hide_text">,
  enabled: boolean
): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const size = drawing?.size
  const w = size?.width ?? 0
  const h = size?.height ?? 0
  useEffect(() => {
    if (!enabled || !w || !h) {
      setUrl(null)
      return
    }
    const px = rasterSize({ width: w, height: h })
    let made: string | null = null
    // Read through a function: the flag flips in the cleanup while run()
    // awaits, which flow narrowing cannot see.
    const life = { cancelled: false }
    const cancelled = () => life.cancelled
    const run = async () => {
      // Stroke widths are screen px after normaliseStrokes; at this raster
      // one px is w / px.width drawing units.
      const unitsPerPx = w / px.width
      let text: string | null = null
      if (source.mode === "inline" && source.svg) {
        text = visibleSvgText(
          source.svg,
          placement.hidden_layers,
          placement.hide_text,
          px,
          unitsPerPx
        )
      } else if (source.mode === "image" && source.imageUrl) {
        const res = await fetch(source.imageUrl, { credentials: "same-origin" })
        if (!res.ok) return
        const root = parseCadSvg(await res.text())
        normaliseStrokes(root)
        text = visibleSvgText(root, [], false, px, unitsPerPx)
      }
      if (!text || cancelled()) return
      made = await rasterise(text, px)
      if (cancelled()) URL.revokeObjectURL(made)
      else setUrl(made)
    }
    run().catch(() => {
      if (!cancelled()) setUrl(null)
    })
    return () => {
      life.cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [
    enabled,
    w,
    h,
    source.mode,
    source.svg,
    source.imageUrl,
    placement.hidden_layers,
    placement.hide_text,
  ])
  return url
}

/**
 * The drawing inside the canvas's pan/zoom group, under the grid: drawing
 * units placed by the mm transform with `scale(pxPerMm)` in front. Never
 * catches the pointer - panning and tile clicks go straight through.
 */
export function CadLayer({
  drawing,
  source,
  placement,
  pxPerMm,
}: {
  drawing: FloorPlanDrawing
  source: CadSource
  placement: FloorPlanDrawingPlacement
  pxPerMm: number
}) {
  const host = useRef<SVGGElement>(null)
  const size = drawing.size

  // Insert a fresh copy of the parsed drawing's nodes; the parsed root is
  // cached across mounts and must stay untouched.
  useLayoutEffect(() => {
    const g = host.current
    if (!g) return
    if (source.mode !== "inline" || !source.svg) {
      g.replaceChildren()
      return
    }
    const nodes = Array.from(source.svg.childNodes).map((n) =>
      g.ownerDocument.importNode(n, true)
    )
    g.replaceChildren(...nodes)
  }, [source.mode, source.svg])

  useLayoutEffect(() => {
    const g = host.current
    if (!g || source.mode !== "inline") return
    applyLayerVisibility(g, placement.hidden_layers, placement.hide_text)
  }, [source.mode, source.svg, placement.hidden_layers, placement.hide_text])

  if (!size.width || !size.height) return null
  return (
    <g
      data-cad-layer=""
      transform={canvasTransform(size, drawing.mm_per_unit, placement, pxPerMm)}
      opacity={placement.opacity / 100}
      pointerEvents="none"
    >
      {source.mode === "image" && source.imageUrl && (
        <image
          href={source.imageUrl}
          width={size.width}
          height={size.height}
          preserveAspectRatio="none"
        />
      )}
      <g ref={host} />
    </g>
  )
}
