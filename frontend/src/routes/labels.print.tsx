import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LabelTemplate, RenderedLabel } from "@/lib/api"
import { labelBody, labelSheetDocument } from "@/lib/label-render"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/labels/print")({
  component: PrintLabelsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : "",
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
})

/** Print through a fresh `window.open()` document that contains ONLY the labels
 * plus the `@page` sheet CSS (the netbox-qrcode approach). Printing the live app
 * page can't size the sheet — the SPA's global styles and hydration swallow the
 * `@page` rule, so the browser falls back to A4 with header/footer. A virgin
 * popup has none of that, so `@page { size; margin:0 }` sizes the sheet to the
 * label and drops the chrome. The doc self-prints and closes on load. */
function printSheet(
  tmpl: Parameters<typeof labelSheetDocument>[0],
  labels: RenderedLabel[]
): boolean {
  const w = window.open("", "_blank", "width=520,height=400")
  if (!w) {
    toast.error("Allow pop-ups for this site to print labels.")
    return false
  }
  w.document.write(labelSheetDocument(tmpl, labels))
  w.document.close()
  return true
}

// This route renders bare (no app shell — see routes/__root.tsx): a small
// on-screen preview of each label plus a Print button. The preview uses the same
// composited HTML (server-sanitized label markup + trusted qrcode.react SVG), so
// it carries no author-executable content.
function PrintLabelsPage() {
  const { template, ids } = useSearch({ from: "/labels/print" })

  const tmplQ = useQuery({
    queryKey: ["label-template", template],
    queryFn: () => api<LabelTemplate>(`/api/label-templates/${template}/`),
    enabled: !!template,
  })
  const renderQ = useQuery({
    queryKey: ["label-render", template, ids],
    queryFn: () =>
      api<{ labels: RenderedLabel[] }>(
        `/api/label-templates/${template}/render/?ids=${ids}`
      ),
    enabled: !!template && !!ids,
  })

  const tmpl = tmplQ.data
  const labels = renderQ.data?.labels

  if (!template || !ids)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing to print — open this from an object's “Print label” action.
      </p>
    )
  if (tmplQ.isError)
    return (
      <div className="p-6">
        <QueryError error={tmplQ.error} />
      </div>
    )
  if (renderQ.isError)
    return (
      <div className="p-6">
        <QueryError error={renderQ.error} />
      </div>
    )
  if (!tmpl || !labels)
    return <p className="p-6 text-sm text-muted-foreground">Rendering…</p>

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-8">
      <div className="flex w-full items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {labels.length} label{labels.length === 1 ? "" : "s"} at{" "}
          {tmpl.width_mm}×{tmpl.height_mm} mm — Print opens a sheet sized to the
          label only.
        </p>
        <Button size="sm" onClick={() => printSheet(tmpl, labels)}>
          <Printer className="h-3.5 w-3.5" /> Print
        </Button>
      </div>
      <div className="flex flex-col items-center gap-3">
        {labels.map((l, i) => (
          <div
            key={l.id ?? i}
            // Each preview cell is sized to the label's true mm dimensions so
            // the operator sees exactly what will print.
            style={{
              width: `${tmpl.width_mm}mm`,
              height: `${tmpl.height_mm}mm`,
              padding: `${tmpl.margin_mm}mm`,
              overflow: "hidden",
              background: "#fff",
              color: "#000",
              border: "1px solid #ccc",
              boxShadow: "0 1px 3px rgba(0,0,0,.15)",
              fontFamily: "ui-sans-serif,system-ui,sans-serif",
              fontSize: "9pt",
            }}
            dangerouslySetInnerHTML={{ __html: labelBody(tmpl, l) }}
          />
        ))}
      </div>
    </div>
  )
}
