import { renderToStaticMarkup } from "react-dom/server"
import { QRCodeSVG } from "qrcode.react"

import type { LabelTemplate, RenderedLabel } from "@/lib/api"

/** A QR as a self-contained SVG string, sized to fill its `qr_size_mm` box. */
function qrMarkup(value: string): string {
  // level "M" + margin keeps it scannable when printed small; the wrapper sizes
  // it in mm, so the intrinsic px size just sets the vector resolution.
  const svg = renderToStaticMarkup(
    <QRCodeSVG value={value || " "} size={256} level="M" marginSize={2} />
  )
  // Let the SVG fill the mm-sized wrapper regardless of its intrinsic px attrs.
  return svg.replace("<svg ", '<svg style="width:100%;height:100%" ')
}

/** Inject the QR SVG into the first `class="qr"` element of the rendered HTML.
 * The template author drops `<div class="qr"></div>` where the code should go. */
function injectQr(html: string, qr: string, sizeMm: number): string {
  const box = `<span style="display:inline-block;width:${sizeMm}mm;height:${sizeMm}mm">${qrMarkup(qr)}</span>`
  const re = /(<([a-z]+)[^>]*class="[^"]*\bqr\b[^"]*"[^>]*>)(<\/\2>)/i
  if (re.test(html)) return html.replace(re, `$1${box}$3`)
  // No placeholder in the template → append the QR so it's never lost.
  return qr ? `${html}${box}` : html
}

/** Full standalone HTML document for one label - the editor's live preview
 * (iframe srcdoc). Sized in mm so the preview matches the printed proportions.
 * Printing goes through the server PDF endpoint (exact physical size); this is
 * screen-only, so it deliberately does not carry `@page`. */
export function labelDocument(
  tmpl: Pick<
    LabelTemplate,
    "width_mm" | "height_mm" | "margin_mm" | "css" | "qr_enabled" | "qr_size_mm"
  >,
  rendered: RenderedLabel
): string {
  const body = tmpl.qr_enabled
    ? injectQr(rendered.html, rendered.qr, tmpl.qr_size_mm)
    : rendered.html
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{
      width:${tmpl.width_mm}mm;height:${tmpl.height_mm}mm;
      padding:${tmpl.margin_mm}mm;
      font-family:ui-sans-serif,system-ui,sans-serif;font-size:9pt;
      color:#000;background:#fff;overflow:hidden;
    }
    ${tmpl.css || ""}
  </style></head><body>${body}</body></html>`
}
