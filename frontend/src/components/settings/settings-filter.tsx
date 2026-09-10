import { createContext, useContext, useMemo, useState } from "react"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { pageOf, SETTINGS_PAGES, visibleCards } from "@/lib/settings-catalog"
import type { SettingsCardEntry, SettingsPage } from "@/lib/settings-catalog"

/**
 * One search box for the settings section (#51).
 *
 * The layout owns the query and the hub reads it back, so typing filters the
 * rail and the tiles at once rather than each surface carrying its own box.
 * Matching is over the catalog - label, description and keywords - which is
 * the point of having a catalog: someone types "relay", or "587", or their
 * vendor's word for a thing, and lands on the right page.
 */
const SettingsFilterContext = createContext<{
  query: string
  setQuery: (q: string) => void
}>({ query: "", setQuery: () => null })

export function SettingsFilterProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [query, setQuery] = useState("")
  return (
    <SettingsFilterContext.Provider value={{ query, setQuery }}>
      {children}
    </SettingsFilterContext.Provider>
  )
}

export function useSettingsFilter() {
  return useContext(SettingsFilterContext)
}

/** The pages a query keeps, in catalog order. An empty query keeps all. */
export function useFilteredPages(pages: SettingsPage[]): SettingsPage[] {
  const { query } = useSettingsFilter()
  return useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return pages
    // Every word has to land somewhere, so "email tenant" narrows rather
    // than widening the way an any-word match would.
    const words = needle.split(/\s+/)
    return pages.filter((page) => {
      const haystack = [
        page.label,
        page.description,
        page.group,
        ...page.keywords,
        ...page.scopes,
      ]
        .join(" ")
        .toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
  }, [pages, query])
}

export function SettingsSearch({ className }: { className?: string }) {
  const { query, setQuery } = useSettingsFilter()
  return (
    <div className={className}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="h-8 pl-8 text-xs"
        />
      </div>
    </div>
  )
}

/** How many pages exist at all - the "n of m" the hub shows while filtering. */
export const SETTINGS_PAGE_COUNT = SETTINGS_PAGES.length

/** Individual settings a query matches, so "session timeout" answers with
 * the card rather than leaving someone to guess it lives under Security.
 *
 * Only runs while there is a query: with none, the pages are the answer. */
export function useMatchingCards(
  pages: SettingsPage[]
): { card: SettingsCardEntry; page: SettingsPage }[] {
  const { query } = useSettingsFilter()
  return useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length < 2) return []
    const words = needle.split(/\s+/)
    return visibleCards(pages)
      .filter((card) => {
        const haystack = [card.label, card.description, ...card.keywords]
          .join(" ")
          .toLowerCase()
        return words.every((w) => haystack.includes(w))
      })
      .flatMap((card) => {
        const page = pageOf(card)
        return page ? [{ card, page }] : []
      })
  }, [pages, query])
}
