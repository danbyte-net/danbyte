import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useRef } from "react"
import { Printer } from "lucide-react"

import { api } from "@/lib/api"
import type { LabelTemplate, RenderedLabel } from "@/lib/api"
import { labelSheet } from "@/lib/label-render"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/labels/print")({
  component: PrintLabelsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : "",
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
})

function PrintLabelsPage() {
  const { template, ids } = useSearch({ from: "/labels/print" })
  const frameRef = useRef<HTMLIFrameElement>(null)

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
  if (!tmplQ.data || !renderQ.data)
    return <p className="p-6 text-sm text-muted-foreground">Rendering…</p>

  const tmpl = tmplQ.data
  const labels = renderQ.data.labels
  const sheet = labelSheet(tmpl, labels)

  // Print the IFRAME's own document, not this page — so the browser prints only
  // the labels (no SPA chrome) and, thanks to @page margin:0, omits its default
  // header/footer (date, URL, page number).
  const doPrint = () => {
    const win = frameRef.current?.contentWindow
    if (win) {
      win.focus()
      win.print()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <h1 className="text-base font-semibold">
          Print · {tmpl.name}{" "}
          <span className="text-muted-foreground">({labels.length})</span>
        </h1>
        <span className="text-xs text-muted-foreground">
          {tmpl.width_mm} × {tmpl.height_mm} mm
        </span>
        <Button size="sm" className="ml-auto" onClick={doPrint}>
          <Printer className="h-3.5 w-3.5" /> Print
        </Button>
      </header>

      {/* One iframe holds every label; we print it directly. */}
      <iframe
        ref={frameRef}
        title="Labels"
        sandbox="allow-same-origin allow-modals"
        srcDoc={sheet}
        className="min-h-0 flex-1 border-0 bg-muted"
      />
    </div>
  )
}
