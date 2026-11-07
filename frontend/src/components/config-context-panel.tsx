import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ConfigContextSource, RenderedConfigContext } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { FileViewer } from "@/components/file-viewer"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Section } from "@/components/ui/section"

/** The sources in merge order: every matching context, then the object's own
 * local context data. Older servers send only `applied`. */
function sourcesOf(data: RenderedConfigContext): ConfigContextSource[] {
  if (data.sources) return data.sources
  return data.applied.map((name) => ({
    kind: "context",
    id: "",
    name,
    weight: 0,
  }))
}

/** Shows the rendered (merged) config context for a device or VM, plus where
 * it came from: each matching context, and the object's local data last.
 * Drop onto a detail page. */
export function ConfigContextPanel({
  endpoint, // "devices" | "virtual-machines"
  id,
}: {
  endpoint: "devices" | "virtual-machines"
  id: string
}) {
  const q = useQuery({
    queryKey: ["config-context-render", endpoint, id],
    queryFn: () =>
      api<RenderedConfigContext>(`/api/${endpoint}/${id}/config-context/`),
    staleTime: 30_000,
  })

  const data = q.data
  const sources = data ? sourcesOf(data) : []
  const empty =
    data && sources.length === 0 && Object.keys(data.rendered).length === 0

  return (
    <Section
      title="Config context"
      badge={
        sources.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {sources.map((s) =>
              s.kind === "local" ? (
                <Badge key="local" variant="outline" className="text-[10px]">
                  {s.name}
                </Badge>
              ) : s.id ? (
                <Badge
                  key={s.id}
                  variant="secondary"
                  className="text-[10px]"
                  asChild
                >
                  <Link to="/config-contexts/$id" params={{ id: s.id }}>
                    {s.name}
                  </Link>
                </Badge>
              ) : (
                <Badge key={s.name} variant="secondary" className="text-[10px]">
                  {s.name}
                </Badge>
              )
            )}
          </span>
        ) : undefined
      }
      description="merged in this order; later sources win"
    >
      {empty ? (
        <EmptyState title="No config contexts yet.">
          None match this object.
        </EmptyState>
      ) : (
        <>
          {(q.isLoading || q.isError) && (
            <div className="rounded-lg border border-border p-4">
              {q.isLoading && <Loading />}
              {q.isError && <QueryError error={q.error} />}
            </div>
          )}
          {data && (
            <FileViewer
              text={JSON.stringify(data.rendered, null, 2)}
              filename="config-context.json"
              language="json"
              storageKey="config-context"
              label="Config context"
            />
          )}
        </>
      )}
    </Section>
  )
}
