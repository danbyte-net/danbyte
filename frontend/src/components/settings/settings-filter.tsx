import { createContext, useContext, useMemo, useState } from "react"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { matchCards, matchPages, SETTINGS_PAGES } from "@/lib/settings-catalog"
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

/** The pages the section's search box keeps, in catalog order. */
export function useFilteredPages(pages: SettingsPage[]): SettingsPage[] {
  const { query } = useSettingsFilter()
  return useMemo(() => matchPages(pages, query), [pages, query])
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

/** The cards the section's search box matches, with their page. */
export function useMatchingCards(
  pages: SettingsPage[]
): { card: SettingsCardEntry; page: SettingsPage }[] {
  const { query } = useSettingsFilter()
  return useMemo(() => matchCards(pages, query), [pages, query])
}
