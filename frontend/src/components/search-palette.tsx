import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Search } from "lucide-react"

import { api } from "@/lib/api"
import type { SearchHit, SearchResponse } from "@/lib/api"
import {
  recentHits,
  recentQueries,
  rememberHit,
  rememberQuery,
} from "@/lib/search-recents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"

const DEBOUNCE_MS = 150
const SUGGEST_LIMIT = 10

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  )
}

/**
 * The global search: a command palette on Ctrl/⌘ K or "/", one ranked list
 * across every object type, key:value tokens, recents when empty. Enter
 * opens the highlighted hit; "See all results" goes to /search.
 */
export function SearchPalette() {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState("")
  const [debounced, setDebounced] = useState("")

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === "/" && !isTypingTarget(e.target) && !e.ctrlKey) {
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(raw.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [raw])

  const q = useQuery({
    queryKey: ["search-suggest", debounced],
    queryFn: () =>
      api<SearchResponse>(
        `/api/search/?q=${encodeURIComponent(debounced)}&limit=${SUGGEST_LIMIT}`
      ),
    enabled: open && debounced.length >= 1,
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  })

  const close = () => {
    setOpen(false)
    setRaw("")
  }

  const openHit = (
    h: Pick<SearchHit, "type" | "type_label" | "title" | "subtitle" | "url">
  ) => {
    rememberHit(h)
    if (debounced) rememberQuery(debounced)
    close()
    // Hit URLs are app paths ("/devices/<id>"); the router resolves them.
    nav({ to: h.url as never })
  }

  const seeAll = () => {
    const term = raw.trim()
    if (!term) return
    rememberQuery(term)
    close()
    nav({ to: "/search", search: { q: term } })
  }

  const hits = q.data?.hits ?? []
  const recents = recentHits()
  const queries = recentQueries()

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-40 min-w-0 shrink justify-start gap-2 text-xs text-muted-foreground sm:w-56"
        onClick={() => setOpen(true)}
        aria-label="Search"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Search…</span>
        <CommandShortcut className="font-mono text-[10px]">⌘K</CommandShortcut>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
        title="Search"
        description="Search every object in the tenant"
        className="sm:max-w-xl"
      >
        {/* Server-ranked: cmdk must not re-filter or re-sort the items. */}
        <Command shouldFilter={false} loop>
          <CommandInput
            value={raw}
            onValueChange={setRaw}
            placeholder="Search - or narrow with type:device site:aarhus role:core tag:dc"
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits.length === 0 && raw.trim()) {
                e.preventDefault()
                seeAll()
              }
            }}
          />
          <CommandList className="max-h-[60vh]">
            {debounced.length === 0 && (
              <>
                {recents.length > 0 && (
                  <CommandGroup heading="Recently opened">
                    {recents.map((h) => (
                      <CommandItem
                        key={h.url}
                        value={`recent-${h.url}`}
                        onSelect={() => openHit(h)}
                      >
                        <HitRow hit={h} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {queries.length > 0 && (
                  <CommandGroup heading="Recent searches">
                    {queries.map((r) => (
                      <CommandItem
                        key={r.q}
                        value={`query-${r.q}`}
                        onSelect={() => setRaw(r.q)}
                      >
                        <Search className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{r.q}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {recents.length === 0 && queries.length === 0 && (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Type a name, an address, a VLAN id or a short id.
                  </p>
                )}
              </>
            )}
            {debounced.length > 0 && q.isLoading && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Searching…
              </p>
            )}
            {debounced.length > 0 && !q.isLoading && hits.length === 0 && (
              <CommandEmpty>No matches.</CommandEmpty>
            )}
            {hits.length > 0 && (
              <CommandGroup heading="Results">
                {hits.map((h) => (
                  <CommandItem
                    key={`${h.type}-${h.id}`}
                    value={`${h.type}-${h.id}`}
                    onSelect={() => openHit(h)}
                  >
                    <HitRow hit={h} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {debounced.length > 0 && (
              <CommandGroup>
                <CommandItem value="see-all" onSelect={seeAll}>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs">
                    See all results
                    {q.data
                      ? ` (${q.data.total}${q.data.total >= 300 ? "+" : ""})`
                      : ""}
                  </span>
                  <CommandShortcut>Enter</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}

function HitRow({
  hit,
}: {
  hit: Pick<SearchHit, "type_label" | "title" | "subtitle">
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Badge variant="secondary" className="shrink-0 text-[10px]">
        {hit.type_label}
      </Badge>
      <span className="truncate font-mono text-xs">{hit.title}</span>
      {hit.subtitle && (
        <span className="truncate text-[11px] text-muted-foreground">
          {hit.subtitle}
        </span>
      )}
    </div>
  )
}
