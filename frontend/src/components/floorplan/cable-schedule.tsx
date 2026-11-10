import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"

import { Field, FormCheckbox } from "@/components/forms"
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
import type {
  CableSchedule,
  CableScheduleEnd,
  CableScheduleRow,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { exportFileName, sendPdf } from "@/lib/diagram/export-file"
import { PAPERS, PAPER_LABELS } from "@/lib/diagram/sheet"
import type { Paper, PaperChoice } from "@/lib/diagram/sheet"
import { downloadBlob, toCsv, toXlsx } from "@/lib/table-export"

import type { PlanBox } from "./plan-svg"
import { MAX_TRACES, TracePicker } from "./trace-picker"

/**
 * **Cable schedule**: the plan's cables as a pull sheet - every cable with
 * a route on this floor or an end on it, its ends, route, lengths and
 * notes, grouped by room or by tray, with totals per type. The server
 * writes the rows (hidden cables counted, not listed); the PDF is laid
 * out there too, optionally under a picture of the plan with its routes
 * (its cables drawn there as bundles, or as the page draws them), with
 * close-ups and a trace page per chosen cable; CSV and XLSX go through the
 * table export, one flat row per cable.
 */

export type ScheduleGroup = "room" | "tray"
export type ScheduleFormat = "pdf" | "csv" | "xlsx"

const GROUP_ITEMS: { value: ScheduleGroup; label: string }[] = [
  { value: "room", label: "Room" },
  { value: "tray", label: "Tray" },
]
const FORMAT_ITEMS: { value: ScheduleFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "XLSX" },
]
const PAPER_ITEMS = (Object.keys(PAPERS) as Paper[]).map((p) => ({
  value: p,
  label: PAPER_LABELS[p],
}))

function endText(ends: readonly CableScheduleEnd[]): string {
  return ends
    .map((e) =>
      e.hidden ? "Hidden" : [e.device, e.port].filter(Boolean).join(" · ")
    )
    .filter(Boolean)
    .join(", ")
}

function roomText(ends: readonly CableScheduleEnd[]): string {
  return [
    ...new Set(ends.filter((e) => !e.hidden && e.room).map((e) => e.room!)),
  ]
    .sort()
    .join(", ")
}

const SOURCE: Record<CableScheduleRow["length_source"], string> = {
  computed: "Computed",
  entered: "Entered",
  "": "",
}

const HEADERS = [
  "Group",
  "Cable",
  "Type",
  "Colour",
  "Status",
  "A end",
  "A room",
  "B end",
  "B room",
  "Route",
  "Computed (m)",
  "Stored",
  "Source",
  "Notes",
]

/** The schedule as a table: one row per cable in each of its groups (by
 * tray, a cable under every tray it rides), then the totals per type and,
 * when some are hidden, how many. */
export function scheduleTable(data: CableSchedule): {
  columns: { header: string; id: string; get: () => string }[]
  rows: string[][]
} {
  const byId = new Map(data.rows.map((r) => [r.id, r]))
  const rows: string[][] = []
  for (const g of data.groups)
    for (const id of g.rows) {
      const r = byId.get(id)
      if (!r) continue
      rows.push([
        g.name,
        r.label,
        r.type_display,
        r.color,
        r.status?.name ?? "",
        endText(r.a),
        roomText(r.a),
        endText(r.b),
        roomText(r.b),
        r.route,
        r.computed_m != null ? String(r.computed_m) : "",
        r.length != null ? `${r.length} ${r.length_unit}` : "",
        SOURCE[r.length_source],
        r.notes,
      ])
    }
  const blank = (cells: string[]) => [
    ...cells,
    ...Array<string>(HEADERS.length - cells.length).fill(""),
  ]
  if (data.totals.length) {
    rows.push(blank([]))
    rows.push(blank(["Totals", "Type", "Cables", "Metres", "Unmeasured"]))
    for (const t of data.totals)
      rows.push(
        blank([
          "",
          t.label,
          String(t.count),
          String(t.metres),
          t.unmeasured ? String(t.unmeasured) : "",
        ])
      )
    rows.push(
      blank([
        "",
        "All",
        String(data.total.count),
        String(data.total.metres),
        data.total.unmeasured ? String(data.total.unmeasured) : "",
      ])
    )
  }
  if (data.hidden_count)
    rows.push(
      blank([
        "Hidden",
        data.hidden_count === 1
          ? "1 cable hidden"
          : `${data.hidden_count} cables hidden`,
      ])
    )
  return {
    columns: HEADERS.map((header) => ({ header, id: header, get: () => "" })),
    rows,
  }
}

/** A close-up page as the server lays it out (`cable-schedule/closeups/`). */
export interface CloseupPage {
  label: string
  box: [number, number, number, number]
  mm_per_px: number
  cables: number
}

/** A trace page: one cable, its box and scale. */
export interface TracePage {
  label: string
  cable: string
  box: [number, number, number, number]
  mm_per_px: number
}

/** How the cables print: drawn by the server as bundles, or as the page
 * draws each one. */
export type ScheduleCables = "bundles" | "lines"

/** Draws the plan for paper: the overview (no `closeup`) or one page
 * framed to its box at its scale; `cables: false` leaves the cables out
 * (the server draws them as bundles). */
export type SchedulePlanSvg = (
  paper: PaperChoice,
  closeup?: { box: PlanBox; mmPerPx: number },
  opts?: { cables?: boolean }
) => Promise<string | null>

/** The layout endpoint's query: the overview's box (its viewBox) unless
 * close-ups are off, and the cables to trace. */
export function layoutQuery(
  sheet: PaperChoice,
  overview: string | null,
  opts: { closeups: boolean; trace: readonly string[] }
): URLSearchParams | null {
  const vb = overview ? /viewBox="([^"]+)"/.exec(overview)?.[1] : undefined
  const closeups = opts.closeups && !!vb
  if (!closeups && !opts.trace.length) return null
  const params = new URLSearchParams({
    size: sheet.size,
    orientation: sheet.orientation,
    closeups: closeups ? "auto" : "off",
  })
  if (vb)
    params.set(
      "box",
      vb
        .trim()
        .split(/[\s,]+/)
        .join(",")
    )
  if (opts.trace.length) params.set("trace", opts.trace.join(","))
  return params
}

/** The plan drawn for each close-up (by label) and trace page (by cable)
 * the PDF will have: the server clusters the cable ends, frames each
 * traced cable and scales each page; each is drawn framed to its box at
 * its scale, so cables and hatches suit the paper. A trace page's plan is
 * drawn without cables - the server draws them. */
export async function scheduleDrawings(
  planId: string,
  sheet: PaperChoice,
  overview: string | null,
  opts: { closeups: boolean; trace: readonly string[]; cables: boolean },
  draw: SchedulePlanSvg
): Promise<{
  closeups: Record<string, string> | null
  traces: Record<string, string> | null
}> {
  const params = layoutQuery(sheet, overview, opts)
  if (!params) return { closeups: null, traces: null }
  const { pages, traces } = await api<{
    pages: CloseupPage[]
    traces?: TracePage[]
  }>(`/api/floor-plans/${planId}/cable-schedule/closeups/?${params}`)
  const closeups: Record<string, string> = {}
  for (const p of pages) {
    const [x, y, w, h] = p.box
    const svg = await draw(
      sheet,
      { box: { x, y, w, h }, mmPerPx: p.mm_per_px },
      { cables: opts.cables }
    )
    if (svg) closeups[p.label] = svg
  }
  const traced: Record<string, string> = {}
  for (const p of traces ?? []) {
    const [x, y, w, h] = p.box
    const svg = await draw(
      sheet,
      { box: { x, y, w, h }, mmPerPx: p.mm_per_px },
      { cables: false }
    )
    if (svg) traced[p.cable] = svg
  }
  return {
    closeups: Object.keys(closeups).length ? closeups : null,
    traces: Object.keys(traced).length ? traced : null,
  }
}

const CABLE_ITEMS: { value: ScheduleCables; label: string }[] = [
  { value: "bundles", label: "Bundles" },
  { value: "lines", label: "Each cable" },
]

/** The schedule's rows, for the trace picker. */
export function useScheduleRows(planId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["floor-plan", planId, "cable-schedule", "rows"],
    queryFn: () =>
      api<CableSchedule>(`/api/floor-plans/${planId}/cable-schedule/`),
    enabled,
    staleTime: 30_000,
  })
}

export function CableScheduleDialog({
  planId,
  planName,
  open,
  onOpenChange,
  planSvg,
  selectedCables,
}: {
  planId: string
  planName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The plan for the PDF: its first page, and each close-up and trace
   * page framed to its box at its scale. */
  planSvg?: SchedulePlanSvg
  /** Cables selected on the plan: the trace pages to start with. */
  selectedCables?: readonly string[]
}) {
  const [group, setGroup] = useState<ScheduleGroup>("room")
  const [format, setFormat] = useState<ScheduleFormat>("pdf")
  const [paper, setPaper] = useState<Paper>("a4")
  const [withPlan, setWithPlan] = useState(true)
  const [closeups, setCloseups] = useState(true)
  const [cables, setCables] = useState<ScheduleCables>("bundles")
  const [tracePages, setTracePages] = useState(false)
  const [trace, setTrace] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const base = `${planName} cable schedule`
  // Opened with cables selected on the plan: those are the trace pages.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && selectedCables?.length) {
      setTrace(selectedCables.slice(0, MAX_TRACES))
      setTracePages(true)
    }
  }
  const pdf = format === "pdf" && !!planSvg
  const schedule = useScheduleRows(planId, open && pdf && tracePages)
  const listed = schedule.data
    ? new Set(schedule.data.rows.map((r) => r.id))
    : null
  // Only the schedule's own cables: a selection may hold others.
  const chosen = listed ? trace.filter((id) => listed.has(id)) : trace

  const run = async () => {
    setBusy(true)
    try {
      if (format === "pdf") {
        const sheet: PaperChoice = { size: paper, orientation: "landscape" }
        const bundles = cables === "bundles"
        const wanted = pdf && tracePages ? chosen : []
        const svg =
          withPlan && planSvg
            ? await planSvg(sheet, undefined, { cables: !bundles })
            : null
        const drawn = planSvg
          ? await scheduleDrawings(
              planId,
              sheet,
              svg,
              { closeups: !!svg && closeups, trace: wanted, cables: !bundles },
              planSvg
            )
          : { closeups: null, traces: null }
        const { url } = await api<{ url: string }>(
          `/api/floor-plans/${planId}/cable-schedule/pdf/?print=1`,
          {
            method: "POST",
            body: JSON.stringify({
              group,
              paper: sheet,
              ...(svg ? { svg, closeups: closeups ? "auto" : "off" } : {}),
              ...(drawn.closeups ? { closeup_svgs: drawn.closeups } : {}),
              ...((svg || wanted.length) && bundles
                ? { cables: "bundles" }
                : {}),
              ...(wanted.length ? { trace: wanted } : {}),
              ...(drawn.traces ? { trace_svgs: drawn.traces } : {}),
            }),
          }
        )
        sendPdf(url, {
          print: false,
          tab: null,
          fileName: exportFileName(base, "pdf", undefined, "cable-schedule"),
        })
      } else {
        const data = await api<CableSchedule>(
          `/api/floor-plans/${planId}/cable-schedule/?group=${group}`
        )
        const { columns, rows } = scheduleTable(data)
        const name = exportFileName(base, format, undefined, "cable-schedule")
        if (format === "csv")
          downloadBlob(name, "text/csv;charset=utf-8", toCsv(columns, rows))
        else
          downloadBlob(
            name,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            toXlsx(columns, rows, {
              name: name.replace(/\.xlsx$/, ""),
              title: base,
              generatedAt: new Date().toISOString(),
            }) as unknown as BlobPart
          )
      }
      onOpenChange(false)
    } catch (err) {
      apiErrorToast(err, "Couldn't make the cable schedule")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-part="cable-schedule">
        <DialogHeader>
          <DialogTitle>Cable schedule</DialogTitle>
          <DialogDescription>
            The cables on this floor, their ends, routes and lengths.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Group by">
            <SegmentedTabs<ScheduleGroup>
              items={GROUP_ITEMS}
              value={group}
              onValueChange={setGroup}
            />
          </Field>
          <Field label="Format">
            <SegmentedTabs<ScheduleFormat>
              items={FORMAT_ITEMS}
              value={format}
              onValueChange={setFormat}
            />
          </Field>
          {format === "pdf" && (
            <Field label="Paper">
              <SegmentedTabs<Paper>
                items={PAPER_ITEMS}
                value={paper}
                onValueChange={setPaper}
              />
            </Field>
          )}
          {pdf && (
            <Field label="Cables">
              <SegmentedTabs<ScheduleCables>
                items={CABLE_ITEMS}
                value={cables}
                onValueChange={setCables}
              />
            </Field>
          )}
          {pdf && (
            <FormCheckbox
              label="Plan on the first page"
              checked={withPlan}
              onChange={setWithPlan}
              className="items-center text-[13px]"
            />
          )}
          {pdf && withPlan && (
            <FormCheckbox
              label="Close-ups of the cabled parts"
              checked={closeups}
              onChange={setCloseups}
              className="items-center text-[13px]"
            />
          )}
          {pdf && (
            <FormCheckbox
              label="Trace pages"
              checked={tracePages}
              onChange={setTracePages}
              className="items-center text-[13px]"
            />
          )}
          {pdf && tracePages && (
            <TracePicker
              rows={schedule.data?.rows}
              value={chosen}
              onChange={setTrace}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            <Download /> {busy ? "Exporting…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
