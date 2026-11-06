import type { DiagramDocument } from "./types"

// The drawing a PDF is made from: the one way the browser turns a diagram
// document into what the server puts on paper. The map's Export ▸ PDF
// (components/topology/export/export-menu.tsx) posts it to
// /api/topology/export/pdf/, and the topology report
// (api/reports/kinds/topology.py) posts the same drawing for its diagram
// page, which the server lays out with the Export's sheet
// (api/topology_export.py `topology_sheet`). A change here reaches both.

export interface PdfDrawing {
  /** The SVG export's drawing and legend; the server draws the title
   * block on the sheet itself. */
  svg: string
  /** The title block's title. */
  title: string
  /** The title block's filters line. */
  filters: string
  generated_at?: string
}

/** `doc` as the PDF's drawing: photos inlined as `data:` images, the
 * legend under it when `legend`. `name` titles a document without one. */
export async function pdfDrawing(
  doc: DiagramDocument,
  name: string,
  opts: { legend: boolean; onMissing?: (n: number) => void }
): Promise<PdfDrawing> {
  const [{ toSvg }, { inlinePhotos }] = await Promise.all([
    import("./svg"),
    import("./png"),
  ])
  const svg = toSvg(await inlinePhotos(doc, { onMissing: opts.onMissing }), {
    legend: opts.legend,
  })
  return {
    svg,
    title: doc.meta.title || name,
    filters: doc.meta.filters ?? "",
    ...(doc.meta.generated_at ? { generated_at: doc.meta.generated_at } : {}),
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The devices a drawing shows: each card's `dev:<id>`, or the device its
 * link opens. */
export function drawingDevices(doc: DiagramDocument): string[] {
  const out = new Set<string>()
  for (const n of doc.nodes) {
    const fromId = n.id.startsWith("dev:") ? n.id.slice(4).match(UUID) : null
    const fromLink = n.link?.match(/\/devices\/([0-9a-f-]{36})/i)
    const id = fromId?.[0] ?? fromLink?.[1]
    if (id) out.add(id.toLowerCase())
  }
  return [...out]
}
