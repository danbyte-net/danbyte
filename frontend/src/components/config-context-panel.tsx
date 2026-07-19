import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RenderedConfigContext } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { Section } from "@/components/ui/section"

/** Shows the rendered (merged) config context for a device or VM, plus which
 * contexts contributed. Drop onto a detail page. */
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
  const empty =
    data && data.applied.length === 0 && Object.keys(data.rendered).length === 0

  return (
    <Section
      title="Config context"
      badge={
        data && data.applied.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {data.applied.map((n) => (
              <Badge key={n} variant="secondary" className="text-[10px]">
                {n}
              </Badge>
            ))}
          </span>
        ) : undefined
      }
      description="merged data from every matching config context"
    >
      {empty ? (
        <EmptyState title="No config contexts yet.">
          None match this object.
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-border p-4">
          {q.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {q.isError && (
            <p className="text-sm text-destructive">
              Couldn't load config context.
            </p>
          )}
          {data && (
            <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
              {JSON.stringify(data.rendered, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Section>
  )
}
