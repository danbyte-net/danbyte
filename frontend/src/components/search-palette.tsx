import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { SearchHit, SearchResponse } from "@/lib/api"
import {
  recentHits,
  recentQueries,
  rememberHit,
  rememberQuery,
} from "@/lib/search-recents"
import {
  matchCards,
  matchPages,
  visiblePages,
} from "@/lib/settings-catalog"
import type { SettingsPage } from "@/lib/settings-catalog"
import { cardAnchor } from "@/components/settings/settings-card"
import { useSettingsScopes } from "@/components/settings/use-settings-scopes"
import { Badge } from "@/components/ui/badge"
import {
  SearchHitContext,
  SearchHitStatus,
} from "@/components/search-hit-context"
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
/** Settings are a sidecar to the object results, not a competing list. */
const SETTINGS_LIMIT = 6

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
// Result rows read as a striped table, not a stack of rounded cards: square
// corners, a hairline between rows, every other row tinted.
// Result groups are full-bleed tables: no inner padding, a top rule, and the
// heading aligned with the rows. Items marked data-row get no rounding
// from the command primitive.
const GROUP_CLS = "border-t border-border/60 p-0 **:[[cmdk-group-heading]]:px-3"

function rowCls(i: number): string {
  return cn(
    "border-b border-border/60 px-3 py-2 last:border-b-0",
    i % 2 ? "bg-muted/30" : undefined
  )
}

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

  // A card links to the page plus its anchor, so the page scrolls to the
  // setting rather than dropping someone at the top of a long one.
  const openSetting = (to: string, hash?: string) => {
    if (debounced) rememberQuery(debounced)
    close()
    nav({ to: to as never, hash })
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
  const settings = useSettingsHits(debounced)

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
          <CommandList className="mt-2 max-h-[60vh]">
            {debounced.length === 0 && (
              <>
                {recents.length > 0 && (
                  <CommandGroup heading="Recently opened" className={GROUP_CLS}>
                    {recents.map((h, i) => (
                      <CommandItem
                        key={h.url}
                        value={`recent-${h.url}`}
                        onSelect={() => openHit(h)}
                        className={rowCls(i)}
                        data-row=""
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
            {debounced.length > 0 &&
              !q.isLoading &&
              hits.length === 0 &&
              settings.length === 0 && <CommandEmpty>No matches.</CommandEmpty>}
            {hits.length > 0 && (
              <CommandGroup heading="Results" className={GROUP_CLS}>
                {hits.map((h, i) => (
                  <CommandItem
                    key={`${h.type}-${h.id}`}
                    value={`${h.type}-${h.id}`}
                    onSelect={() => openHit(h)}
                    className={rowCls(i)}
                    data-row=""
                  >
                    <HitRow hit={h} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {settings.length > 0 && (
              <CommandGroup heading="Settings" className={GROUP_CLS}>
                {settings.map((hit, i) => (
                  <CommandItem
                    key={hit.key}
                    value={hit.key}
                    onSelect={() => openSetting(hit.to, hit.hash)}
                    className={rowCls(i)}
                    data-row=""
                  >
                    <SettingRow label={hit.label} where={hit.where} />
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

interface SettingHit {
  key: string
  label: string
  /** The page it sits on, or the group it belongs to. */
  where: string
  to: string
  hash?: string
}

/**
 * Settings the query matches, cards first (#51).
 *
 * The settings section has its own search box, but nobody looking for
 * "session timeout" thinks to open Settings first - they type it here. The
 * catalog is the same one that builds the hub, so a result is a page that
 * exists and the scopes gate it exactly as the section does.
 */
function useSettingsHits(query: string): SettingHit[] {
  const held = useSettingsScopes()
  const pages = visiblePages(held)
  if (!query) return []

  const cards: SettingHit[] = matchCards(pages, query).map(({ card, page }) => ({
    key: `setting-card-${card.key}`,
    label: card.label,
    where: page.label,
    to: page.to,
    hash: cardAnchor(card.label),
  }))
  const seen = new Set(cards.map((c) => c.to))
  const rest: SettingHit[] = matchPages(pages, query)
    .filter((p: SettingsPage) => !seen.has(p.to))
    .map((p: SettingsPage) => ({
      key: `setting-page-${p.key}`,
      label: p.label,
      where: p.description,
      to: p.to,
    }))

  return [...cards, ...rest].slice(0, SETTINGS_LIMIT)
}

function SettingRow({ label, where }: { label: string; where: string }) {
  return (
    <div className="grid min-w-0 flex-1 grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-0.5">
      <Badge variant="secondary" className="justify-center text-[10px]">
        Settings
      </Badge>
      <span className="min-w-0 truncate text-xs">{label}</span>
      <span className="col-start-2 min-w-0 truncate text-[11px] text-muted-foreground">
        {where}
      </span>
    </div>
  )
}

function HitRow({
  hit,
}: {
  hit: Pick<SearchHit, "type_label" | "title" | "subtitle"> & {
    context?: SearchHit["context"]
  }
}) {
  const ctx = { context: hit.context ?? {}, subtitle: hit.subtitle }
  // Fixed columns so the eye scans down: type · name · status · details.
  return (
    <div className="grid min-w-0 flex-1 grid-cols-[6.5rem_1fr_auto] items-center gap-x-3 gap-y-0.5">
      <Badge variant="secondary" className="justify-center text-[10px]">
        {hit.type_label}
      </Badge>
      <span className="min-w-0 font-mono text-xs break-all">{hit.title}</span>
      <span className="min-w-0">
        <SearchHitStatus hit={ctx} />
      </span>
      {/* Details wrap on their own line under the name - nothing is cut. */}
      <SearchHitContext
        hit={ctx}
        max={4}
        withStatus={false}
        className="col-span-2 col-start-2"
      />
    </div>
  )
}
