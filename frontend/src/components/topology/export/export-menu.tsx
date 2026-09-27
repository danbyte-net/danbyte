import { useState } from "react"
import {
  ChevronDown,
  Download,
  FileCode,
  FileImage,
  Workflow,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useStatusLabels } from "@/components/monitoring/status-palette"
import type { DiagramDocument } from "@/lib/diagram/types"
import { downloadBlob } from "@/lib/table-export"
import type { LegendItem } from "../legend"

// One Export menu for the topology map: PNG, SVG and draw.io, with the few
// choices that change the file - whole map or what is on screen, Simple or
// Detailed for draw.io (and its photos, off by default: a card is what a
// draw.io user edits), and the title block with the legend. The files are
// drawn from the map's data (to-document.ts / from-flow.ts), never from the
// screen, so they are light-themed and carry every card. Photos go into
// the PNG and SVG as downscaled `data:` images, so the files stand alone.
// The writers load on first use.

export type ExportArea = "all" | "visible"
export type ExportFormat = "png" | "svg" | "drawio"

export interface ExportRequest {
  area: ExportArea
  /** draw.io only: the file's mode. */
  mode?: "simple" | "detailed"
}

interface Prefs {
  area: ExportArea
  drawio: "simple" | "detailed"
  /** draw.io: photo nodes as their photos, not cards. */
  photos: boolean
  /** Title block and legend under PNG and SVG drawings. */
  extras: boolean
}

const KEY = "topology:export"
const DEFAULTS: Prefs = {
  area: "all",
  drawio: "simple",
  photos: false,
  extras: true,
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>
    return {
      area: raw.area === "visible" ? "visible" : "all",
      drawio: raw.drawio === "detailed" ? "detailed" : "simple",
      photos: raw.photos === true,
      extras: raw.extras !== false,
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

/** `DC1 fabric` on 26 Sep 2026 → `dc1-fabric-2026-09-26.<ext>`. */
export function exportFileName(
  name: string,
  ext: string,
  date: Date = new Date()
): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "topology"
  const p = (n: number) => String(n).padStart(2, "0")
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  return `${slug}-${day}.${ext}`
}

/** Menu radio and checkbox rows adjust the export without closing it. */
const keepOpen = (e: Event) => e.preventDefault()

export function ExportMenu({
  document: buildDocument,
  capturePng,
  modes = false,
  legend,
  name,
  disabled,
}: {
  /** The map as an export document. */
  document: (req: ExportRequest) => DiagramDocument | null
  /** The legacy tabs' PNG: a capture of the canvas (a data URL). Absent =
   * the PNG is the SVG rasterised. */
  capturePng?: (visibleOnly: boolean) => Promise<string | null>
  /** Offer Simple and Detailed for draw.io (the Diagram tab). */
  modes?: boolean
  /** The legend's entries (legend.tsx `legendRows`), for the files. */
  legend?: readonly LegendItem[]
  /** The file name's base: the view's name. */
  name: string
  disabled?: boolean
}) {
  const [prefs, setPrefs] = useState(readPrefs)
  const [busy, setBusy] = useState(false)
  const checks = useStatusLabels()
  const set = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p }
    setPrefs(next)
    writePrefs(next)
  }

  /** The document, with the legend when the title block is on. */
  const build = async (mode?: Prefs["drawio"]) => {
    const doc = buildDocument({ area: prefs.area, mode })
    if (!doc || !prefs.extras || !legend?.length) return doc
    const { printLegend } = await import("../diagram/to-document")
    return {
      ...doc,
      meta: { ...doc.meta, legend: printLegend(legend, checks) },
    }
  }

  const run = async (format: ExportFormat) => {
    setBusy(true)
    try {
      if (format === "png" && capturePng) {
        const url = await capturePng(prefs.area === "visible")
        if (!url) return
        const a = window.document.createElement("a")
        a.href = url
        a.download = exportFileName(name, "png")
        a.click()
        return
      }
      const doc = await build(
        format === "drawio" ? (modes ? prefs.drawio : "simple") : undefined
      )
      if (!doc) return
      const extras = { titleBlock: prefs.extras, legend: prefs.extras }
      if (format === "png") {
        const { diagramToPng } = await import("@/lib/diagram/png")
        const blob = await diagramToPng(doc, { ...extras, scale: 2 })
        downloadBlob(exportFileName(name, "png"), "image/png", blob)
      } else if (format === "svg") {
        const [{ toSvg }, { inlinePhotos }] = await Promise.all([
          import("@/lib/diagram/svg"),
          import("@/lib/diagram/png"),
        ])
        downloadBlob(
          exportFileName(name, "svg"),
          "image/svg+xml",
          toSvg(await inlinePhotos(doc), { ...extras, links: true })
        )
      } else {
        const [{ DRAWIO_MIME, toDrawio }, { inlinePhotos }] = await Promise.all(
          [import("@/lib/diagram/drawio"), import("@/lib/diagram/png")]
        )
        const photos = modes && prefs.photos
        downloadBlob(
          exportFileName(name, "drawio"),
          DRAWIO_MIME,
          toDrawio([photos ? await inlinePhotos(doc, { scale: 1.25 }) : doc], {
            mode: doc.meta.mode ?? "simple",
            photos,
          })
        )
      }
    } catch {
      toast.error("Couldn't export the map")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-24 text-xs"
              disabled={disabled || busy}
            >
              <Download className="h-3 w-3" />
              {busy ? "Exporting…" : "Export"}
              {!busy && <ChevronDown className="h-3 w-3" />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" variant="panel">
          Download this map
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => void run("png")}>
          <FileImage /> PNG
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("svg")}>
          <FileCode /> SVG
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("drawio")}>
          <Workflow /> draw.io
        </DropdownMenuItem>
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
        {modes && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>draw.io</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={prefs.drawio}
              onValueChange={(v) =>
                set({ drawio: v === "detailed" ? "detailed" : "simple" })
              }
            >
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
