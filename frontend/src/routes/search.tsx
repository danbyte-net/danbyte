import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"

import {
  api,
  SEARCH_GROUPS,
  type SearchHit,
  type SearchResponse,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/search")({
  validateSearch: (s: Record<string, unknown>) => ({
    q: typeof s.q === "string" ? s.q : "",
  }),
  component: SearchResultsPage,
})

const RESULTS_LIMIT = 50

function SearchResultsPage() {
  const { q } = Route.useSearch()
  const [activeGroup, setActiveGroup] = useState<string>("all")

  const query = useQuery({
    queryKey: ["search-results", q],
    queryFn: () =>
      api<SearchResponse>(
        `/api/search/?q=${encodeURIComponent(q)}&limit=${RESULTS_LIMIT}`
      ),
    enabled: q.length >= 1,
    staleTime: 10 * 1000,
  })

  // Build the visible group list — only groups with >0 hits get a tab.
  const visibleGroups = useMemo(() => {
    if (!query.data) return []
    return SEARCH_GROUPS.filter(
      ({ key }) => query.data!.groups[key]?.length > 0
    )
  }, [query.data])

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <Search className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Search</h1>
        {q && (
          <span className="font-mono text-xs text-muted-foreground">"{q}"</span>
        )}
        {query.data && (
          <Badge variant="secondary" className="rounded-md">
            {query.data.total} hit{query.data.total === 1 ? "" : "s"}
          </Badge>
        )}
      </header>

      {!q && (
        <p className="p-6 text-sm text-muted-foreground">
          Type a query in the top bar and press Enter.
        </p>
      )}

      {q && query.isLoading && (
        <p className="p-6 text-sm text-muted-foreground">Searching…</p>
      )}
      {q && query.isError && (
        <div className="p-6">
          <QueryError error={query.error} />
        </div>
      )}

      {query.data && (
        <>
          {/* Group filter bar — "All" + one tab per non-empty group. */}
          <nav className="flex h-10 shrink-0 items-center overflow-x-auto border-b border-border px-3">
            <SegmentedTabs
              value={activeGroup}
              onValueChange={setActiveGroup}
              items={[
                { value: "all", label: "All", count: query.data.total },
                ...visibleGroups.map(({ key, label }) => ({
                  value: key,
                  label,
                  count: query.data!.groups[key].length,
                })),
              ]}
            />
          </nav>

          <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
            {query.data.total === 0 ? (
              <p className="text-sm text-muted-foreground">
                No matches for "{q}".
              </p>
            ) : (
              <div className="flex flex-col gap-8">
                {SEARCH_GROUPS.map(({ key, label }) => {
                  const hits = query.data!.groups[key]
                  if (hits.length === 0) return null
                  if (activeGroup !== "all" && activeGroup !== key) return null
                  return <GroupTable key={key} label={label} hits={hits} />
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function GroupTable({ label, hits }: { label: string; hits: SearchHit[] }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        {label}{" "}
        <span className="ml-1 text-muted-foreground/70">({hits.length})</span>
      </h2>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-64 text-xs">Match</TableHead>
              <TableHead className="text-xs">Description</TableHead>
              <TableHead className="text-xs">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hits.map((hit) => (
              <TableRow key={String(hit.id)}>
                <TableCell className="py-2">
                  <Link
                    to={hit.url as never}
                    className="font-mono text-[13px] text-foreground hover:underline"
                  >
                    {hit.label}
                  </Link>
                </TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground">
                  {hit.sublabel || "—"}
                </TableCell>
                <TableCell className="py-2 text-[11px] text-muted-foreground">
                  {summarizeExtras(hit)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function summarizeExtras(hit: SearchHit): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(hit.extras)) {
    if (v == null || v === "" || v === false) continue
    parts.push(`${k}: ${String(v)}`)
  }
  return parts.join(" · ") || "—"
}
