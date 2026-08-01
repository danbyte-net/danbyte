import { createFileRoute, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"

import { api } from "@/lib/api"
import type { LabelTemplate, RenderedLabel } from "@/lib/api"
import { labelBody, sheetCss } from "@/lib/label-render"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/labels/print")({
  component: PrintLabelsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : "",
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
})

// A BARE page (no app shell — see routes/__root.tsx) whose own document IS the
// label sheet: `@page { margin: 0 }` sized to the label, one label per page. So
// the browser prints only the labels — whether the user clicks Print or hits
// Ctrl+P — with no header/footer and no SPA chrome (the netbox-qr behaviour).
//
// Safety: each label's HTML is sanitized server-side (api.label_templates —
// scripts/handlers stripped) and the QR is a trusted qrcode.react SVG, so this
// inline render carries no author-executable markup.
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
    <>
      {/* Sizes the page to the label, zero @page margin, hides the toolbar in
          print, and gives an on-screen grey backdrop. */}
      <style dangerouslySetInnerHTML={{ __html: sheetCss(tmpl) }} />
      <div
        className="print-toolbar"
        style={{ position: "fixed", top: 12, right: 12, zIndex: 10 }}
      >
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" /> Print {labels.length} label
          {labels.length === 1 ? "" : "s"}
        </Button>
      </div>
      {labels.map((l, i) => (
        <div
          key={l.id ?? i}
          className="lbl"
          dangerouslySetInnerHTML={{ __html: labelBody(tmpl, l) }}
        />
      ))}
    </>
  )
}
