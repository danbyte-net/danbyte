import { useState } from "react"
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

/**
 * **Cable schedule**: the plan's cables as a pull sheet - every cable with
 * a route on this floor or an end on it, its ends, route, lengths and
 * notes, grouped by room or by tray, with totals per type. The server
 * writes the rows (hidden cables counted, not listed); the PDF is laid
 * out there too, optionally under a picture of the plan with its routes;
 * CSV and XLSX go through the table export.
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

export function CableScheduleDialog({
  planId,
  planName,
  open,
  onOpenChange,
  planSvg,
}: {
  planId: string
  planName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The plan with its routes, for the PDF's first page. */
  planSvg?: (paper: PaperChoice) => Promise<string | null>
}) {
  const [group, setGroup] = useState<ScheduleGroup>("room")
  const [format, setFormat] = useState<ScheduleFormat>("pdf")
  const [paper, setPaper] = useState<Paper>("a4")
  const [withPlan, setWithPlan] = useState(true)
  const [busy, setBusy] = useState(false)
  const base = `${planName} cable schedule`

  const run = async () => {
    setBusy(true)
    try {
      if (format === "pdf") {
        const sheet: PaperChoice = { size: paper, orientation: "landscape" }
        const svg = withPlan && planSvg ? await planSvg(sheet) : null
        const { url } = await api<{ url: string }>(
          `/api/floor-plans/${planId}/cable-schedule/pdf/?print=1`,
          {
            method: "POST",
            body: JSON.stringify({
              group,
              paper: sheet,
              ...(svg ? { svg } : {}),
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
          {format === "pdf" && planSvg && (
            <FormCheckbox
              label="Plan on the first page"
              checked={withPlan}
              onChange={setWithPlan}
              className="items-center text-[13px]"
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
