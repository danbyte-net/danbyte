import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Application, ApplicationFlow, Paginated } from "@/lib/api"
import { buildFlowDocument } from "@/lib/diagram/flow-document"
import { useMe } from "@/lib/use-me"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { ExportMenu } from "@/components/topology/export/export-menu"

// The application's Diagram tab (#163): its flows drawn by the same
// document and writers as every other diagram export - endpoints left to
// right, one band for the application, an arrowed line per flow - with the
// shared Export menu (PNG, SVG, PDF, draw.io, Print).

const PDF_URL = "/api/diagram/export/pdf/?print=1"

export function ApplicationFlowDiagram({ app }: { app: Application }) {
  const { me } = useMe()
  const q = useQuery({
    queryKey: ["application-flows", "application", app.id],
    queryFn: () =>
      api<Paginated<ApplicationFlow>>(
        `/api/application-flows/?application=${app.id}`
      ),
  })
  const flows = useMemo(() => q.data?.results ?? [], [q.data])
  const tenant = me.active_tenant?.name

  const build = useMemo(
    () => () =>
      buildFlowDocument(flows, {
        title: app.name,
        generatedAt: new Date().toISOString(),
        tenant,
        origin: window.location.origin,
        applicationId: app.id,
      }),
    [flows, app.name, app.id, tenant]
  )

  // The drawing on screen is the SVG export itself; the writer loads on
  // first use, as the Export menu's do.
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    if (!flows.length) return
    let live = true
    void import("@/lib/diagram/svg").then(({ toSvg }) => {
      if (live) setSvg(toSvg(build()))
    })
    return () => {
      live = false
    }
  }, [flows, build])

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (!flows.length) return <EmptyState title="No flows to draw." />

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <ExportMenu
          name={app.name}
          fileStem={`${app.slug}-flows`}
          pdfUrl={PDF_URL}
          pdfKind="application-flows"
          areas={false}
          document={build}
        />
      </div>
      {svg === null ? (
        <Loading />
      ) : (
        <div
          className="overflow-auto rounded-lg border [&>svg]:block [&>svg]:max-w-none"
          // The writer's own markup: shapes and escaped text, no scripts.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
