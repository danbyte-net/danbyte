import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useRef } from "react"
import { Printer } from "lucide-react"

import { api } from "@/lib/api"
import type { LabelTemplate, RenderedLabel } from "@/lib/api"
import { labelSheetDoc } from "@/lib/label-render"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/labels/print")({
  component: PrintLabelsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : "",
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
})

// Rendered as a BARE page (no app shell — see routes/__root.tsx). The labels
// live inside a SANDBOXED iframe: it carries `allow-same-origin` (so the Print
// button can call its `print()`) but NOT `allow-scripts`, so author-controlled
// template markup — a rogue `<script>` or `<img onerror=…>` — cannot execute in
// the app origin. Printing the iframe's own document (@page margin:0) is clean:
// no SPA chrome, no browser header/footer.
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
  const doc = labelSheetDoc(tmpl, labels)

  const doPrint = () => {
    const win = frameRef.current?.contentWindow
    if (win) {
      win.focus()
      win.print()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:px-6">
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
      <iframe
        ref={frameRef}
        title="Labels"
        // No allow-scripts: label template markup can't run JS in the app.
        sandbox="allow-same-origin allow-modals"
        srcDoc={doc}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  )
}
