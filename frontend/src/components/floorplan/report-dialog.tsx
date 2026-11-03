import { useState } from "react"
import { Download, Printer } from "lucide-react"
import { toast } from "sonner"

import { readPaper, writePaper } from "@/components/drawing-export-menu"
import { Field, FormCheckbox, FormCombobox } from "@/components/forms"
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
import { api } from "@/lib/api"
import type { FloorPlanReportTables } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import { PAPERS, PAPER_LABELS } from "@/lib/diagram/sheet"
import type { Orientation, Paper, PaperChoice } from "@/lib/diagram/sheet"
import { downloadBlob, toCsv, toXlsx } from "@/lib/table-export"

import type { PlanBox } from "./plan-svg"
import { reportBody, reportScopeBody, reportTable } from "./report"
import type {
  ReportInclude,
  ReportOptions,
  ReportScope,
  ReportSheet,
} from "./report"

/**
 * **Export…**: one PDF report of what the screen shows, the whole floor, a
 * room or area on it, or every level of its building - the plan sheet(s),
 * and as chosen the cable schedule, the inventory and the connected ports
 * (api/floor_plan_report.py). The page draws each sheet; the server works
 * out the scope and builds the tables. CSV and XLSX carry the tables.
 */

export type ReportFormat = "pdf" | "csv" | "xlsx"

/** Where this browser keeps the report's paper. */
const PAPER_KEY = "floorplan:report"
const DEFAULT_PAPER: PaperChoice = { size: "a3", orientation: "landscape" }

/** A room or area the report can be cut to. */
export interface ReportArea {
  id: string
  name: string
  kind: "room" | "location"
}

/** What the page draws for a sheet: `box` (plan px) at its paper scale -
 * `floor` the level, absent for the plan open. */
export type DrawSheet = (req: {
  scope: ReportScope
  paper: PaperChoice
  floor?: string
  area?: string
}) => Promise<ReportSheet | null>

const SCOPE_LABELS: Record<ReportScope, string> = {
  view: "This view",
  floor: "Whole floor",
  area: "Room / area",
  building: "Building",
}
const INCLUDE_ITEMS: { value: ReportInclude; label: string }[] = [
  { value: "plan", label: "Plan drawing" },
  { value: "cables", label: "Cable schedule" },
  { value: "inventory", label: "Inventory" },
  { value: "ports", label: "Ports summary" },
]
const FORMAT_ITEMS: { value: ReportFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "XLSX" },
]
const PAPER_ITEMS = (Object.keys(PAPERS) as Paper[]).map((p) => ({
  value: p,
  label: PAPER_LABELS[p],
}))
const ORIENTATION_ITEMS: { value: Orientation; label: string }[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
]

/** The request the dialog's state makes - the scope's fields only. */
export function reportOptions(state: {
  scope: ReportScope
  include: ReadonlySet<ReportInclude>
  paper: PaperChoice
  area: string | null
  box?: PlanBox | null
  hiddenTiles?: readonly string[]
}): ReportOptions {
  return {
    scope: state.scope,
    include: INCLUDE_ITEMS.map((i) => i.value).filter((v) =>
      state.include.has(v)
    ),
    paper: state.paper,
    box: state.scope === "view" ? (state.box ?? undefined) : undefined,
    area: state.scope === "area" ? (state.area ?? undefined) : undefined,
    hiddenTiles: state.hiddenTiles,
  }
}

export function ReportDialog({
  planId,
  name,
  open,
  onOpenChange,
  areas,
  levels,
  screenBox,
  hiddenTiles,
  draw,
}: {
  planId: string
  /** The files' name before the day. */
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  areas: readonly ReportArea[]
  /** The building's levels in order; null when the plan is in none. */
  levels: readonly { id: string; name: string }[] | null
  /** What the screen shows (plan px), cut to the plan; null when hidden.
   * Absent where no plan is on screen (the 3D room). */
  screenBox?: () => PlanBox | null
  /** Tiles hidden on screen: left out of the inventory. */
  hiddenTiles: readonly string[]
  draw: DrawSheet
}) {
  const [scopePick, setScope] = useState<ReportScope>("floor")
  const [area, setArea] = useState<string | null>(null)
  const [paper, setPaper] = useState<PaperChoice>(() =>
    readPaper(PAPER_KEY, DEFAULT_PAPER)
  )
  const [include, setInclude] = useState<ReadonlySet<ReportInclude>>(
    () => new Set<ReportInclude>(["plan"])
  )
  const [format, setFormat] = useState<ReportFormat>("pdf")
  const [busy, setBusy] = useState(false)

  const scopes = (Object.keys(SCOPE_LABELS) as ReportScope[])
    .filter((s) => (s === "area" ? areas.length > 0 : true))
    .filter((s) => (s === "building" ? !!levels?.length : true))
    .filter((s) => (s === "view" ? !!screenBox : true))
    .map((value) => ({ value, label: SCOPE_LABELS[value] }))
  const scope = scopes.some((s) => s.value === scopePick) ? scopePick : "floor"
  const areaId = area ?? (areas.length ? areas[0].id : null)
  const includes =
    format === "pdf"
      ? INCLUDE_ITEMS
      : INCLUDE_ITEMS.filter((i) => i.value !== "plan")
  const chosen = includes.filter((i) => include.has(i.value))
  const ready = chosen.length > 0 && (scope !== "area" || !!areaId)

  const toggle = (v: ReportInclude, on: boolean) => {
    const next = new Set(include)
    if (on) next.add(v)
    else next.delete(v)
    setInclude(next)
  }

  const run = async (print: boolean) => {
    const tab = print ? openPrintTab() : null
    let printing = false
    setBusy(true)
    try {
      const box = scope === "view" ? (screenBox?.() ?? null) : null
      if (scope === "view" && !box) {
        toast.error("The view shows none of the plan")
        return
      }
      const options = reportOptions({
        scope,
        include: new Set(chosen.map((c) => c.value)),
        paper,
        area: areaId,
        box,
        hiddenTiles,
      })
      writePaper(PAPER_KEY, paper)
      const base = `${name} report`
      if (format !== "pdf") {
        const data = await api<FloorPlanReportTables>(
          `/api/floor-plans/${planId}/export/report/tables/`,
          { method: "POST", body: JSON.stringify(reportScopeBody(options)) }
        )
        const { columns, rows } = reportTable(data)
        const file = exportFileName(
          base,
          format,
          undefined,
          "floor-plan-report"
        )
        if (format === "csv")
          downloadBlob(file, "text/csv;charset=utf-8", toCsv(columns, rows))
        else
          downloadBlob(
            file,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            toXlsx(columns, rows, {
              name: file.replace(/\.xlsx$/, ""),
              title: data.title,
              generatedAt: new Date().toISOString(),
            }) as unknown as BlobPart
          )
        onOpenChange(false)
        return
      }
      const sheets: ReportSheet[] = []
      if (options.include.includes("plan")) {
        const wanted =
          scope === "building"
            ? (levels ?? []).map((l) => l.id)
            : [undefined as string | undefined]
        for (const floor of wanted) {
          const sheet = await draw({
            scope,
            paper,
            floor,
            area: areaId ?? undefined,
          })
          if (sheet) sheets.push(sheet)
        }
      }
      const { url } = await api<{ url: string }>(
        `/api/floor-plans/${planId}/export/report/?print=1`,
        { method: "POST", body: JSON.stringify(reportBody(options, sheets)) }
      )
      printing = sendPdf(url, {
        print,
        tab,
        fileName: exportFileName(base, "pdf", undefined, "floor-plan-report"),
      })
      onOpenChange(false)
    } catch (err) {
      apiErrorToast(err, "Couldn't make the report")
    } finally {
      if (tab && !printing) tab.close()
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-part="floor-plan-report">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            One report: the plan, and the tables you pick.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="What">
            <SegmentedTabs<ReportScope>
              items={scopes}
              value={scope}
              onValueChange={setScope}
              wrap
            />
          </Field>
          {scope === "area" && (
            <FormCombobox
              label="Room or area"
              value={areaId}
              onChange={setArea}
              options={areas.map((a) => ({
                value: a.id,
                label: a.name,
                group: a.kind === "room" ? "Rooms" : "Locations",
              }))}
              placeholder="Pick a room or area…"
            />
          )}
          <Field label="Format">
            <SegmentedTabs<ReportFormat>
              items={FORMAT_ITEMS}
              value={format}
              onValueChange={setFormat}
            />
          </Field>
          {format === "pdf" && (
            <>
              <Field label="Paper">
                <SegmentedTabs<Paper>
                  items={PAPER_ITEMS}
                  value={paper.size}
                  onValueChange={(size) => setPaper({ ...paper, size })}
                />
              </Field>
              <Field label="Orientation">
                <SegmentedTabs<Orientation>
                  items={ORIENTATION_ITEMS}
                  value={paper.orientation}
                  onValueChange={(orientation) =>
                    setPaper({ ...paper, orientation })
                  }
                />
              </Field>
            </>
          )}
          <Field label="Include">
            <div className="grid gap-2">
              {includes.map((i) => (
                <FormCheckbox
                  key={i.value}
                  label={i.label}
                  checked={include.has(i.value)}
                  onChange={(on) => toggle(i.value, on)}
                  className="items-center text-[13px]"
                />
              ))}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {format === "pdf" && (
            <Button
              variant="outline"
              disabled={busy || !ready}
              onClick={() => void run(true)}
            >
              <Printer /> Print
            </Button>
          )}
          <Button disabled={busy || !ready} onClick={() => void run(false)}>
            <Download /> {busy ? "Exporting…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
