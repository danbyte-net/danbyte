import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { FileText } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

/**
 * The inventory report (api/reports/kinds/inventory.py, docs/dcim/stock.md):
 * a PDF of the Inventory page's rows under its current filters - totals by
 * status and kind, counts per part and place, and the items appendix -
 * with the usual cover.
 */

type Section = "totals" | "counts" | "items"

const SECTIONS: { key: Section; label: string }[] = [
  { key: "totals", label: "Totals" },
  { key: "counts", label: "Counts per part" },
  { key: "items", label: "Items" },
]

interface Estimate {
  rows: number
  cells: number
  mode: "now" | "too_large"
  detail?: string
}

/** The list's filters as the report takes them: the rail and the search. */
export function reportFilters(params: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(params))
    if (k.startsWith("f_") || k === "search") out[k] = v
  return out
}

export function InventoryReportButton({ params }: { params: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileText />
        PDF report…
      </Button>
      <InventoryReportDialog
        open={open}
        onOpenChange={setOpen}
        filters={reportFilters(params)}
      />
    </>
  )
}

export function InventoryReportDialog({
  open,
  onOpenChange,
  filters,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: Record<string, string>
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [title, setTitle] = useState("Inventory report")
  const [sections, setSections] = useState<Section[]>([
    "totals",
    "counts",
    "items",
  ])
  const [paper, setPaper] = useState("a4")
  const [orientation, setOrientation] = useState("portrait")
  const [cover, setCover] = useState(false)
  useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const body = {
    title: title.trim(),
    filters,
    sections,
    options: { paper, orientation, cover },
  }
  const estimate = useQuery({
    queryKey: ["inventory", "report-estimate", JSON.stringify(body)],
    queryFn: () =>
      api<Estimate>("/api/inventory/report/?estimate=1", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    enabled: open && sections.length > 0,
  })

  const make = useMutation({
    mutationFn: async (print: boolean) => {
      const tab = print ? openPrintTab() : null
      try {
        const r = await api<{ url: string }>("/api/inventory/report/?print=1", {
          method: "POST",
          body: JSON.stringify(body),
        })
        sendPdf(r.url, {
          print,
          tab,
          fileName: exportFileName(title || "inventory", "pdf"),
        })
      } catch (err) {
        tab?.close()
        throw err
      }
    },
    onSuccess: () => onOpenChange(false),
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const toggle = (s: Section, on: boolean) =>
    setSections((cur) =>
      on
        ? SECTIONS.map((x) => x.key).filter((k) => k === s || cur.includes(k))
        : cur.filter((k) => k !== s)
    )
  const tooLarge = estimate.data?.mode === "too_large"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Inventory report</DialogTitle>
          <DialogDescription>
            {estimate.data
              ? `${estimate.data.rows.toLocaleString()} parts under the current filters`
              : "The parts under the current filters"}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (sections.length && !tooLarge) make.mutate(false)
          }}
          className="grid gap-4"
        >
          <FormText
            label="Title"
            value={title}
            onChange={setTitle}
            error={fieldErrors.title}
          />
          <div className="grid gap-2">
            {SECTIONS.map((s) => (
              <FormCheckbox
                key={s.key}
                label={s.label}
                checked={sections.includes(s.key)}
                onChange={(on) => toggle(s.key, on)}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Paper"
              value={paper}
              onChange={(v) => setPaper(v ?? "a4")}
              options={[
                { value: "a4", label: "A4" },
                { value: "letter", label: "Letter" },
                { value: "a3", label: "A3" },
              ]}
            />
            <FormSelect
              label="Orientation"
              value={orientation}
              onChange={(v) => setOrientation(v ?? "portrait")}
              options={[
                { value: "portrait", label: "Portrait" },
                { value: "landscape", label: "Landscape" },
              ]}
            />
          </div>
          <FormCheckbox
            label="Cover page"
            checked={cover}
            onChange={setCover}
          />
          {tooLarge && (
            <p className="text-sm text-destructive">{estimate.data?.detail}</p>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={make.isPending}
            submitLabel="Download"
            submittingLabel="Making…"
            secondary={
              <Button
                type="button"
                variant="outline"
                disabled={!sections.length || tooLarge || make.isPending}
                onClick={() => make.mutate(true)}
              >
                Print
              </Button>
            }
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
