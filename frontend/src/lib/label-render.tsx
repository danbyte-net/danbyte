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

/** Full standalone HTML document for one label — used both for the live
 * preview (iframe srcdoc) and the print sheet. Sized in mm via `@page` so a
 * label printer / the browser print dialog produces true physical dimensions. */
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

type SheetTmpl = Pick<
  LabelTemplate,
  "width_mm" | "height_mm" | "margin_mm" | "css" | "qr_enabled" | "qr_size_mm"
>

/** The inner HTML for one label (QR composited in). */
export function labelBody(tmpl: SheetTmpl, label: RenderedLabel): string {
  return tmpl.qr_enabled
    ? injectQr(label.html, label.qr, tmpl.qr_size_mm)
    : label.html
}

/** A complete standalone HTML document holding every label — opened in a fresh
 * `window.open()` popup and printed there (the netbox-qrcode approach). A virgin
 * document carries none of the SPA's global CSS or hydration, so the `@page`
 * rule in `sheetCss` actually sizes the sheet to the label and drops the
 * browser's margins/headers — which it silently won't do when the same `<style>`
 * is injected into the live app document. The QR SVG is already composited into
 * each label's HTML (trusted qrcode.react), and the label HTML is sanitized
 * server-side, so writing this string carries no XSS. It self-prints on load. */
export function labelSheetDocument(
  tmpl: SheetTmpl,
  labels: RenderedLabel[]
): string {
  const cells = labels
    .map((l) => `<div class="lbl">${labelBody(tmpl, l)}</div>`)
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><title>Print labels</title>
<style>${sheetCss(tmpl)}</style></head>
<body onload="setTimeout(function(){window.focus();window.print();},80)" onafterprint="window.close()">${cells}</body></html>`
}

/** The stylesheet for a print sheet: `@page` sized to the label with zero
 * margin (so the browser omits its header/footer), each `.lbl` sized in mm and
 * hard-page-broken, plus the template's own CSS. Injected into the print page's
 * document — used by the /labels/print route, which is a bare page (no SPA
 * chrome) so both the Print button and Ctrl+P produce clean labels. */
export function sheetCss(tmpl: SheetTmpl): string {
  return `
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff}
    @page{ size:${tmpl.width_mm}mm ${tmpl.height_mm}mm; margin:0; }
    .lbl{
      width:${tmpl.width_mm}mm;height:${tmpl.height_mm}mm;
      padding:${tmpl.margin_mm}mm;
      font-family:ui-sans-serif,system-ui,sans-serif;font-size:9pt;
      color:#000;background:#fff;overflow:hidden;
      page-break-after:always;break-after:page;
    }
    .lbl:last-child{ page-break-after:auto;break-after:auto; }
    /* On screen, centre the stack with a little gap; print collapses it. */
    @media screen{
      body{padding:16px;display:flex;flex-direction:column;gap:12px;align-items:center;background:#e5e7eb}
      .lbl{border:1px solid #ccc;box-shadow:0 1px 3px rgba(0,0,0,.15)}
    }
  `
}
