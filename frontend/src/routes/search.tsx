import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"

import { api } from "@/lib/api"
import type { SearchHit, SearchResponse } from "@/lib/api"
import { rememberHit, rememberQuery } from "@/lib/search-recents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { SearchHitContext } from "@/components/search-hit-context"
import { usePageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/search")({
  validateSearch: (
    s: Record<string, unknown>
  ): { q: string; type?: string } => ({
    q: typeof s.q === "string" ? s.q : "",
    ...(typeof s.type === "string" && s.type ? { type: s.type } : {}),
  }),
  component: SearchResultsPage,
})

const PAGE = 50

function SearchResultsPage() {
  usePageTitle("Search")
  const { q, type: typeParam } = Route.useSearch()
  const type = typeParam ?? ""
  const navigate = Route.useNavigate()
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    setCursor(0)
    if (q) rememberQuery(q)
  }, [q, type])

  const query = useQuery({
    queryKey: ["search-results", q, type, cursor],
    queryFn: () =>
      api<SearchResponse>(
        `/api/search/?q=${encodeURIComponent(q)}&limit=${PAGE}&cursor=${cursor}` +
          (type ? `&type=${encodeURIComponent(type)}` : "")
      ),
    enabled: q.length >= 1,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  })

  const facets = query.data?.facets.types ?? []
  const total = query.data?.total ?? 0

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <Search className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Search</span>
        <span className="font-mono text-sm text-muted-foreground">{q}</span>
        {query.data && (
          <Badge variant="secondary">
            {total}
            {total >= 300 ? "+" : ""} result{total === 1 ? "" : "s"}
          </Badge>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 lg:p-6">
        {!q && (
          <p className="text-sm text-muted-foreground">
            Type in the search box, or press ⌘K / Ctrl+K anywhere. Narrow a
            query with tokens: <span className="font-mono">type:device</span>,{" "}
            <span className="font-mono">site:aarhus</span>,{" "}
            <span className="font-mono">role:core</span>,{" "}
            <span className="font-mono">status:active</span>,{" "}
            <span className="font-mono">tag:dc</span>.
          </p>
        )}
        {query.isError && <QueryError error={query.error} />}
        {q && query.data && (
          <>
            {facets.length > 1 && (
              <SegmentedTabs
                value={type || "all"}
                onValueChange={(v) =>
                  navigate({
                    search: v === "all" ? { q } : { q, type: v },
                  })
                }
                items={[
                  { value: "all", label: "All", count: total },
                  ...facets.map((f) => ({
                    value: f.type,
                    label: f.label,
                    count: f.count,
                  })),
                ]}
              />
            )}
            {query.data.hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">Type</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.hits.map((h) => (
                      <HitRow key={`${h.type}-${h.id}`} hit={h} q={q} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {(cursor > 0 || query.data.next_cursor !== null) && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {cursor + 1}–{cursor + query.data.hits.length} of {total}
                  {total >= 300 ? "+" : ""}
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cursor === 0}
                    onClick={() => setCursor(Math.max(0, cursor - PAGE))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={query.data.next_cursor === null}
                    onClick={() => setCursor(query.data?.next_cursor ?? cursor)}
                  >
                    Next
                  </Button>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Wraps the folded query's first occurrence in <mark>, else plain text. */
function Highlight({ text, q }: { text: string; q: string }) {
  const words = q
    .split(/\s+/)
    .filter((w) => w && !w.includes(":"))
    .map((w) => w.toLowerCase())
  const lower = text.toLowerCase()
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i >= 0)
      return (
        <>
          {text.slice(0, i)}
          <mark className="rounded-sm bg-primary/20 px-0.5 text-inherit">
            {text.slice(i, i + w.length)}
          </mark>
          {text.slice(i + w.length)}
        </>
      )
  }
  return <>{text}</>
}

function HitRow({ hit, q }: { hit: SearchHit; q: string }) {
  return (
    <TableRow>
      <TableCell>
        <Badge variant="secondary" className="text-[10px]">
          {hit.type_label}
        </Badge>
      </TableCell>
      <TableCell>
        <Link
          to={hit.url as never}
          className="link font-mono text-[13px] font-medium"
          onClick={() => rememberHit(hit)}
        >
          <Highlight text={hit.title} q={q} />
        </Link>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {hit.subtitle && (
          <div className="mb-0.5">
            <Highlight text={hit.subtitle} q={q} />
          </div>
        )}
        <SearchHitContext hit={{ ...hit, subtitle: "" }} />
        {!hit.subtitle && Object.keys(hit.context).length === 0 && "-"}
      </TableCell>
    </TableRow>
  )
}
