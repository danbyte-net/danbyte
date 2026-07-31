import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"

import { api } from "@/lib/api"
import type { LabelTemplate, RenderedLabel } from "@/lib/api"
import { labelDocument } from "@/lib/label-render"
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar — hidden when printing. */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6 print:hidden">
        <h1 className="text-base font-semibold">
          Print · {tmpl.name}{" "}
          <span className="text-muted-foreground">({labels.length})</span>
        </h1>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" /> Print
        </Button>
      </header>

      {/* @page sizes each sheet to one label so a label printer feeds correctly;
          on an office printer the labels tile down the page. */}
      <style>{`@page { size: ${tmpl.width_mm}mm ${tmpl.height_mm}mm; margin: 0; }
        @media print { html, body { background: #fff; } .label-sheet { gap: 0 !important; } }`}</style>

      <div className="label-sheet flex flex-wrap content-start gap-3 overflow-auto p-4 print:p-0">
        {labels.map((lbl, i) => (
          <iframe
            key={lbl.id ?? i}
            title={`Label ${i + 1}`}
            sandbox=""
            srcDoc={labelDocument(tmpl, lbl)}
            className="print:break-inside-avoid"
            style={{
              width: `${tmpl.width_mm}mm`,
              height: `${tmpl.height_mm}mm`,
              border: "1px solid var(--border)",
              background: "#fff",
            }}
          />
        ))}
      </div>
    </div>
  )
}
