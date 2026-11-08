import { useCallback, useState } from "react"
import {
  BookText,
  ChevronDown,
  Download,
  FileCode,
  FileImage,
  FileText,
  Printer,
  Workflow,
} from "lucide-react"
import { toast } from "sonner"

import { BarButton } from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useStatusLabels } from "@/components/monitoring/status-palette"
import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import { drawingDevices, pdfDrawing } from "@/lib/diagram/pdf-drawing"
import type { PdfDrawing } from "@/lib/diagram/pdf-drawing"
import {
  MIN_PRINT_PT,
  PAPERS,
  PAPER_LABELS,
  paperLabel,
  planSheet,
  printedPt,
} from "@/lib/diagram/sheet"
import type { Orientation, Paper } from "@/lib/diagram/sheet"
import type { DiagramDocument } from "@/lib/diagram/types"
import { downloadBlob } from "@/lib/table-export"
import type { LegendItem } from "../legend"

// One Export menu for the topology map: PNG, SVG, PDF and draw.io, and
// Print, with the few choices that change the file - whole map or what is on
// screen, draw.io as the map is shown or as Simple or Detailed (and its
// photos, off by default: a
// card is what a draw.io user edits), the PDF's paper, and the title block
// with the legend. The files are drawn from the map's data (to-document.ts /
// from-flow.ts), never from the screen, so they are light-themed and carry
// every card. Photos go into the PNG, SVG and PDF as downscaled `data:`
// images, so the files stand alone. The writers load on first use.
//
// The PDF is the SVG laid out on real paper by the server (a browser can't
// be made to print at a paper size): it answers with a short-lived link,
// which PDF downloads and Print opens in a new tab for the browser's viewer.

export type ExportArea = "all" | "visible"
export type ExportFormat = "png" | "svg" | "pdf" | "print" | "drawio"

export interface ExportRequest {
  area: ExportArea
  /** draw.io only: the file's mode. */
  mode?: "simple" | "detailed"
}

type DrawioMode = "simple" | "detailed"

interface Prefs {
  area: ExportArea
  /** draw.io: "shown" follows the map's own mode. */
  drawio: "shown" | DrawioMode
  /** draw.io: photo nodes as their photos, not cards. */
  photos: boolean
  /** Title block and legend under the drawing (PNG, SVG and PDF). */
  extras: boolean
  /** The PDF's paper. */
  paper: Paper
  orientation: Orientation
}

const KEY = "topology:export"
const DEFAULTS: Prefs = {
  area: "all",
  drawio: "shown",
  photos: false,
  extras: true,
  paper: "a3",
  orientation: "landscape",
}

const isPaper = (v: unknown): v is Paper =>
  typeof v === "string" && Object.hasOwn(PAPERS, v)

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>
    return {
      area: raw.area === "visible" ? "visible" : "all",
      drawio:
        raw.drawio === "detailed" || raw.drawio === "simple"
          ? raw.drawio
          : "shown",
      photos: raw.photos === true,
      extras: raw.extras !== false,
      paper: isPaper(raw.paper) ? raw.paper : DEFAULTS.paper,
      orientation: raw.orientation === "portrait" ? "portrait" : "landscape",
    }
  } catch {
    return DEFAULTS
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private window or blocked storage: the choice lasts this visit */
  }
}

export { exportFileName }

/** What a topology report's diagram page is made from: the Export's PDF
 * drawing of the whole map, the devices it shows, and whether the title
 * block is on. */
export interface ReportDrawing {
  drawing: PdfDrawing
  devices: string[]
  titleBlock: boolean
}

/** The map as its Export's files draw it: `buildDocument`'s document, with
 * the legend when the title block is on. Shared by the Export menu and the
 * topology report, so both draw the same map. */
export function useExportDocument(
  buildDocument: (req: ExportRequest) => DiagramDocument | null,
  legend: readonly LegendItem[] | undefined
) {
  const checks = useStatusLabels()
  return useCallback(
    async (req: ExportRequest, extras: boolean) => {
      const doc = buildDocument(req)
      if (!doc || !extras || !legend?.length) return doc
      const { printLegend } = await import("../diagram/to-document")
      return {
        ...doc,
        meta: { ...doc.meta, legend: printLegend(legend, checks) },
      }
    },
    [buildDocument, legend, checks]
  )
}

/** The report's drawing of the whole map, as **Export ▸ PDF** draws it. */
export async function reportDrawing(
  build: (
    req: ExportRequest,
    extras: boolean
  ) => Promise<DiagramDocument | null>,
  name: string,
  extras: boolean
): Promise<ReportDrawing | null> {
  const doc = await build({ area: "all" }, extras)
  if (!doc) return null
  const drawing = await pdfDrawing(doc, name, { legend: extras })
  return { drawing, devices: drawingDevices(doc), titleBlock: extras }
}

/** The Export's Title and legend choice, as this browser keeps it. */
export function exportExtras(): boolean {
  return readPrefs().extras
}

/** Menu radio and checkbox rows adjust the export without closing it. */
const keepOpen = (e: Event) => e.preventDefault()

/** The smallest text the writers draw (port names, pills), px. */
const SMALLEST_TEXT_PX = 9

const PDF_URL = "/api/topology/export/pdf/?print=1"

export function ExportMenu({
  document: buildDocument,
  modes = false,
  shownMode = "detailed",
  legend,
  name,
  fileStem,
  pdfUrl = PDF_URL,
  pdfKind,
  areas = true,
  disabled,
  onReport,
}: {
  /** The map as an export document. */
  document: (req: ExportRequest) => DiagramDocument | null
  /** Offer Simple and Detailed for draw.io (the Diagram tab). */
  modes?: boolean
  /** The mode the map is shown in; draw.io follows it by default. */
  shownMode?: DrawioMode
  /** The legend's entries (legend.tsx `legendRows`), for the files. */
  legend?: readonly LegendItem[]
  /** The file name's base: the view's name. */
  name: string
  /** The file name's base when it is not the name (an application's
   * flows: "shop-flows"). */
  fileStem?: string
  /** Where the PDF is made, with `?print=1`: the topology's by default; a
   * diagram of another kind posts to `/api/diagram/export/pdf/?print=1`… */
  pdfUrl?: string
  /** …with its `kind` (#163), whose view permission the server checks. */
  pdfKind?: string
  /** Offer Whole map / Visible area: off for a diagram drawn whole. */
  areas?: boolean
  disabled?: boolean
  /** Offer **PDF report…**: opens the report dialog with the way to draw
   * the map as this menu's PDF does. */
  onReport?: (draw: () => Promise<ReportDrawing | null>) => void
}) {
  const base = fileStem ?? name
  const [prefs, setPrefs] = useState(readPrefs)
  const [busy, setBusy] = useState(false)
  const exportDocument = useExportDocument(buildDocument, legend)
  const set = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p }
    setPrefs(next)
    writePrefs(next)
  }

  /** The document, with the legend when the title block is on. */
  const build = (mode?: DrawioMode) =>
    exportDocument({ area: prefs.area, mode }, prefs.extras)

  const run = async (format: ExportFormat) => {
    // Print's tab opens now, while the click still counts as the user's.
    const tab = format === "print" ? openPrintTab() : null
    let printing = false
    setBusy(true)
    try {
      const doc = await build(
        format !== "drawio"
          ? undefined
          : !modes
            ? "simple"
            : prefs.drawio === "shown"
              ? shownMode
              : prefs.drawio
      )
      if (!doc) return
      const extras = { titleBlock: prefs.extras, legend: prefs.extras }
      // Photos that would not load are drawn as cards: said once the file
      // is out, so it can be exported again.
      let missing = 0
      const onMissing = (n: number) => {
        missing = n
      }
      if (format === "pdf" || format === "print") {
        const { svgSize } = await import("@/lib/diagram/png")
        // The one PDF drawing (lib/diagram/pdf-drawing.ts), which the
        // topology report's diagram page posts too.
        const drawing = await pdfDrawing(doc, name, {
          legend: prefs.extras,
          onMissing,
        })
        const svg = drawing.svg
        const paper = { size: prefs.paper, orientation: prefs.orientation }
        const { url } = await api<{ url: string }>(pdfUrl, {
          method: "POST",
          body: JSON.stringify({
            ...(pdfKind ? { kind: pdfKind } : {}),
            svg,
            title: drawing.title,
            paper,
            meta: {
              view: name,
              filters: drawing.filters,
              generated_at: drawing.generated_at,
            },
            title_block: prefs.extras,
          }),
        })
        printing = sendPdf(url, {
          print: format === "print",
          tab,
          fileName: exportFileName(base, "pdf"),
        })
        const plan = planSheet(svgSize(svg), paper, {
          titleBlock: prefs.extras,
        })
        if (printedPt(SMALLEST_TEXT_PX, plan) < MIN_PRINT_PT)
          toast.warning(
            `Labels print under ${MIN_PRINT_PT} pt on ${paperLabel(paper)}`
          )
      } else if (format === "png") {
        const { diagramToPng } = await import("@/lib/diagram/png")
        const blob = await diagramToPng(doc, { ...extras, scale: 2, onMissing })
        downloadBlob(exportFileName(base, "png"), "image/png", blob)
      } else if (format === "svg") {
        const [{ toSvg }, { inlinePhotos }] = await Promise.all([
          import("@/lib/diagram/svg"),
          import("@/lib/diagram/png"),
        ])
        downloadBlob(
          exportFileName(base, "svg"),
          "image/svg+xml",
          toSvg(await inlinePhotos(doc, { onMissing }), {
            ...extras,
            links: true,
          })
        )
      } else {
        const [{ DRAWIO_MIME, toDrawio }, { inlinePhotos }] = await Promise.all(
          [import("@/lib/diagram/drawio"), import("@/lib/diagram/png")]
        )
        const photos = modes && prefs.photos
        downloadBlob(
          exportFileName(base, "drawio"),
          DRAWIO_MIME,
          toDrawio(
            [
              photos
                ? await inlinePhotos(doc, { scale: 1.25, onMissing })
                : doc,
            ],
            { mode: doc.meta.mode ?? "simple", photos }
          )
        )
      }
      if (missing)
        toast.warning(
          missing === 1
            ? "1 photo didn't load and is drawn as a card"
            : `${missing} photos didn't load and are drawn as cards`
        )
    } catch (err) {
      if (format === "pdf" || format === "print")
        apiErrorToast(err, "Couldn't make PDF")
      else toast.error("Couldn't export map")
    } finally {
      // A Print that didn't get as far as its PDF leaves no blank tab.
      if (tab && !printing) tab.close()
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* BarMenuTrigger's markup, but while a file is made the verb
            changes and the chevron makes room for it, so the width holds. */}
        <BarButton className="min-w-24" disabled={disabled || busy}>
          <Download />
          {busy ? "Exporting…" : "Export"}
          {!busy && <ChevronDown data-icon="inline-end" />}
        </BarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={() => void run("png")}>
          <FileImage /> PNG
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("svg")}>
          <FileCode /> SVG
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("pdf")}>
          <FileText /> PDF
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("drawio")}>
          <Workflow /> draw.io
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("print")}>
          <Printer /> Print
        </DropdownMenuItem>
        {onReport && (
          <DropdownMenuItem
            onSelect={() =>
              onReport(() => reportDrawing(exportDocument, name, prefs.extras))
            }
          >
            <BookText /> PDF report…
          </DropdownMenuItem>
        )}
        {areas && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Area</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={prefs.area}
              onValueChange={(v) =>
                set({ area: v === "visible" ? "visible" : "all" })
              }
            >
              <DropdownMenuRadioItem value="all" onSelect={keepOpen}>
                Whole map
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="visible" onSelect={keepOpen}>
                Visible area
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
        {modes && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>draw.io</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={prefs.drawio}
              onValueChange={(v) =>
                set({
                  drawio: v === "detailed" || v === "simple" ? v : "shown",
                })
              }
            >
              <DropdownMenuRadioItem value="shown" onSelect={keepOpen}>
                As shown
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="simple" onSelect={keepOpen}>
                Simple
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="detailed" onSelect={keepOpen}>
                Detailed
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuCheckboxItem
              checked={prefs.photos}
              onCheckedChange={(v) => set({ photos: v })}
              onSelect={keepOpen}
            >
              Photos
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="whitespace-nowrap">
            Paper
            <span className="ml-auto pl-3 text-xs text-muted-foreground">
              {paperLabel({
                size: prefs.paper,
                orientation: prefs.orientation,
              })}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-36">
            <DropdownMenuRadioGroup
              value={prefs.paper}
              onValueChange={(v) => {
                if (isPaper(v)) set({ paper: v })
              }}
            >
              {(Object.keys(PAPERS) as Paper[]).map((p) => (
                <DropdownMenuRadioItem key={p} value={p} onSelect={keepOpen}>
                  {PAPER_LABELS[p]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={prefs.orientation}
              onValueChange={(v) =>
                set({
                  orientation: v === "portrait" ? "portrait" : "landscape",
                })
              }
            >
              <DropdownMenuRadioItem value="landscape" onSelect={keepOpen}>
                Landscape
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="portrait" onSelect={keepOpen}>
                Portrait
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={prefs.extras}
          onCheckedChange={(v) => set({ extras: v })}
          onSelect={keepOpen}
        >
          Title and legend
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
