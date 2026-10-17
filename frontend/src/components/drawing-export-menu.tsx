import { useState } from "react"
import {
  ChevronDown,
  Download,
  FileCode,
  FileImage,
  FileText,
  Printer,
} from "lucide-react"
import { toast } from "sonner"

import { Field } from "@/components/forms"
import { BarButton } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import type { EmbeddedFont } from "@/lib/diagram/markup"
import {
  MIN_PRINT_PT,
  PAPERS,
  PAPER_LABELS,
  paperLabel,
  planSheet,
  printedPt,
} from "@/lib/diagram/sheet"
import type { Orientation, Paper, PaperChoice } from "@/lib/diagram/sheet"
import { downloadBlob } from "@/lib/table-export"
import { cn } from "@/lib/utils"

// The Export menu of a drawing the page builds as a vector - a rack's
// elevation, a cabinet's plate (rack-export-menu.tsx, cabinet-export-menu.tsx):
// PNG, SVG, PDF… and Print, as the topology map exports. Every file is the
// one drawing (`build`), light-themed whatever the app's theme: the SVG as
// it is, the PNG that SVG rasterised at 2x, the PDF that SVG laid out on real
// paper by the server, under a title block the server writes. PDF… asks for
// the paper; Print uses the paper last chosen, which the menu shows. Where a
// mode has no vector drawing yet (Render), `snapshot` makes the PNG from the
// screen, and `note` says what the other files draw instead.

export type DrawingFormat = "png" | "svg" | "pdf" | "print"

/** What a file asks of the drawing. */
export interface DrawingRequest {
  /** Inter, to inline: the SVG file and the PNG carry it; the PDF's
   * server has its own. */
  fonts: EmbeddedFont[]
  /** The drawing's own name and facts over it: off on the PDF, whose
   * sheet the server titles. */
  heading: boolean
}

export interface DrawingBuild {
  svg: string
  /** Photos that would not load, drawn without them. */
  missing: number
}

/** The smallest text the elevation writers draw (unit numbers), px. */
const SMALLEST_TEXT_PX = 9

const isPaper = (v: unknown): v is Paper =>
  typeof v === "string" && Object.hasOwn(PAPERS, v)

function readPaper(key: string, fallback: PaperChoice): PaperChoice {
  try {
    const raw = JSON.parse(
      localStorage.getItem(key) ?? "{}"
    ) as Partial<PaperChoice>
    return {
      size: isPaper(raw.size) ? raw.size : fallback.size,
      orientation:
        raw.orientation === "portrait" || raw.orientation === "landscape"
          ? raw.orientation
          : fallback.orientation,
    }
  } catch {
    return fallback
  }
}

function writePaper(key: string, p: PaperChoice) {
  try {
    localStorage.setItem(key, JSON.stringify(p))
  } catch {
    /* private window or blocked storage: the choice lasts this visit */
  }
}

async function loadFonts(): Promise<EmbeddedFont[]> {
  const { interFonts } = await import("@/lib/diagram/png")
  // Without the font the drawing still renders, on the fallback stack.
  return interFonts().catch(() => [])
}

const PAPER_ITEMS = (Object.keys(PAPERS) as Paper[]).map((p) => ({
  value: p,
  label: PAPER_LABELS[p],
}))
const ORIENTATION_ITEMS: { value: Orientation; label: string }[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
]

export function DrawingExportMenu({
  name,
  build,
  pdfUrl,
  paperKey,
  defaultPaper,
  snapshot,
  note,
  svg = true,
  pdfExtra,
  disabled,
  className,
}: {
  /** The files' name before the day: `R12 elevation` →
   * `r12-elevation-2026-10-02.png`. */
  name: string
  /** The drawing, as an SVG; null while there is nothing to draw yet. */
  build: (req: DrawingRequest) => Promise<DrawingBuild | null>
  /** The drawing's PDF endpoint, posted the SVG and the paper. */
  pdfUrl: string
  /** Where this browser keeps the paper last chosen. */
  paperKey: string
  /** The paper until one is chosen. */
  defaultPaper: PaperChoice
  /** The PNG from the screen, for a mode the drawing does not cover. */
  snapshot?: () => Promise<void>
  /** A word in the menu and the PDF dialog on what the files draw. */
  note?: string
  /** Offer the SVG file - off where the server adds to the drawing (a floor
   * plan's CAD drawing), so the SVG alone would be less than the PDF. */
  svg?: boolean
  /** More of the PDF request beside the SVG and the paper. */
  pdfExtra?: () => Record<string, unknown>
  disabled?: boolean
  className?: string
}) {
  const [paper, setPaper] = useState(() => readPaper(paperKey, defaultPaper))
  const [draft, setDraft] = useState(paper)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (format: DrawingFormat, sheet: PaperChoice = paper) => {
    // Print's tab opens now, while the click still counts as the user's.
    const tab = format === "print" ? openPrintTab() : null
    let printing = false
    setBusy(true)
    try {
      if (format === "png" && snapshot) {
        await snapshot()
        return
      }
      const pdf = format === "pdf" || format === "print"
      const drawing = await build({
        fonts: pdf ? [] : await loadFonts(),
        heading: !pdf,
      })
      if (!drawing) return
      if (pdf) {
        const { url } = await api<{ url: string }>(`${pdfUrl}?print=1`, {
          method: "POST",
          body: JSON.stringify({
            ...pdfExtra?.(),
            svg: drawing.svg,
            paper: { size: sheet.size, orientation: sheet.orientation },
          }),
        })
        printing = sendPdf(url, {
          print: format === "print",
          tab,
          fileName: exportFileName(name, "pdf", undefined, "drawing"),
        })
        const { svgSize } = await import("@/lib/diagram/png")
        const plan = planSheet(svgSize(drawing.svg), sheet)
        if (printedPt(SMALLEST_TEXT_PX, plan) < MIN_PRINT_PT)
          toast.warning(
            `Labels print under ${MIN_PRINT_PT} pt on ${paperLabel(sheet)}`
          )
      } else if (format === "png") {
        const { svgToPng } = await import("@/lib/diagram/png")
        downloadBlob(
          exportFileName(name, "png", undefined, "drawing"),
          "image/png",
          await svgToPng(drawing.svg, { scale: 2 })
        )
      } else {
        downloadBlob(
          exportFileName(name, "svg", undefined, "drawing"),
          "image/svg+xml",
          drawing.svg
        )
      }
      if (drawing.missing)
        toast.warning(
          drawing.missing === 1
            ? "1 photo didn't load and is drawn as its box"
            : `${drawing.missing} photos didn't load and are drawn as boxes`
        )
    } catch (err) {
      if (format === "pdf" || format === "print")
        apiErrorToast(err, "Couldn't make PDF")
      else toast.error("Couldn't export drawing")
    } finally {
      // A Print that didn't get as far as its PDF leaves no blank tab.
      if (tab && !printing) tab.close()
      setBusy(false)
    }
  }

  /** The dialog's PDF or Print, on the paper it shows - kept for next time. */
  const fromDialog = (format: "pdf" | "print") => {
    setPaper(draft)
    writePaper(paperKey, draft)
    setAsking(false)
    void run(format, draft)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The word and the chevron go when the toolbar is narrow, so the
              row never wraps for them; screen readers keep the word. While
              a file is made the verb changes and the chevron makes room for
              it, so the width holds. */}
          <BarButton
            className={cn("@[34rem]:min-w-24", className)}
            disabled={disabled || busy}
          >
            <Download />
            <span className="sr-only @[34rem]:not-sr-only">
              {busy ? "Exporting…" : "Export"}
            </span>
            {/* No data-icon: its tighter right padding would stay when the
                chevron goes, and push the lone icon off centre. */}
            {!busy && (
              <ChevronDown className="hidden @[34rem]:-mr-1 @[34rem]:block" />
            )}
          </BarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {note && (
            <>
              <DropdownMenuLabel className="max-w-56 font-normal">
                {note}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => void run("png")}>
            <FileImage /> PNG
          </DropdownMenuItem>
          {svg && (
            <DropdownMenuItem onSelect={() => void run("svg")}>
              <FileCode /> SVG
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setDraft(paper)
              setAsking(true)
            }}
          >
            <FileText /> PDF…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run("print")}>
            <Printer /> Print
            <span className="ml-auto pl-3 text-xs whitespace-nowrap text-muted-foreground">
              {paperLabel(paper)}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>PDF</DialogTitle>
            <DialogDescription>
              One sheet, with a title block.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="Paper">
              <SegmentedTabs<Paper>
                items={PAPER_ITEMS}
                value={draft.size}
                onValueChange={(size) => setDraft({ ...draft, size })}
              />
            </Field>
            <Field label="Orientation">
              <SegmentedTabs<Orientation>
                items={ORIENTATION_ITEMS}
                value={draft.orientation}
                onValueChange={(orientation) =>
                  setDraft({ ...draft, orientation })
                }
              />
            </Field>
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => fromDialog("print")}>
              <Printer /> Print
            </Button>
            <Button onClick={() => fromDialog("pdf")}>
              <Download /> Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
