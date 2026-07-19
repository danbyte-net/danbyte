import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"

import {
  api,
  SEARCH_GROUPS,
  type SearchHit,
  type SearchResponse,
} from "@/lib/api"
import { Input } from "@/components/ui/input"

// Top-of-page global search.
//
// Debounced suggester popover with grouped hits (Prefixes, IPs, VLANs…).
// Enter navigates to the full /search results page; Escape clears + blurs.
// Click on a suggestion deep-links to the matching detail page.

const DEBOUNCE_MS = 180
const SUGGEST_LIMIT = 6

export function GlobalSearch() {
  const nav = useNavigate()
  const [raw, setRaw] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounce on the URL we actually hit.
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
    enabled: debounced.length >= 1,
    staleTime: 5 * 1000,
  })

  // Click-outside closes the popover.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  function submit() {
    const term = raw.trim()
    if (!term) return
    setOpen(false)
    nav({ to: "/search", search: { q: term } })
  }

  const hasResults = !!q.data && q.data.total > 0
  const showPopover = open && debounced.length >= 1

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            submit()
          } else if (e.key === "Escape") {
            setRaw("")
            setOpen(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        placeholder="Search prefixes, IPs, VLANs…"
        className="h-8 w-full pl-8 text-xs"
        aria-label="Global search"
      />
      {showPopover && (
        <div className="absolute top-full right-0 z-50 mt-1 max-h-[60vh] w-[28rem] max-w-[90vw] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {q.isLoading && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Searching…
            </p>
          )}
          {!q.isLoading && q.data && q.data.total === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No matches. Press Enter to open the full results page.
            </p>
          )}
          {!q.isLoading && hasResults && (
            <>
              {SEARCH_GROUPS.map(({ key, label }) => {
                const hits = q.data!.groups[key]
                if (!hits || hits.length === 0) return null
                return (
                  <div
                    key={key}
                    className="border-b border-border last:border-b-0"
                  >
                    <div className="bg-muted/40 px-3 py-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      {label}
                    </div>
                    <ul>
                      {hits.map((h) => (
                        <li key={h.id}>
                          <SuggestionLink
                            hit={h}
                            onPick={() => setOpen(false)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
              <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-[11px]">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={submit}
                >
                  See all results for{" "}
                  <span className="font-medium text-foreground">
                    "{debounced}"
                  </span>{" "}
                  ↵
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SuggestionLink({
  hit,
  onPick,
}: {
  hit: SearchHit
  onPick: () => void
}) {
  return (
    <Link
      to={hit.url as never}
      onClick={onPick}
      className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/60"
    >
      {/* Main column — full value, never truncated. shrink-0 keeps the
          flex layout from squeezing an IP/CIDR down to its first octet. */}
      <span className="shrink-0 font-mono text-[12px] whitespace-nowrap text-foreground">
        {hit.label}
      </span>
      {hit.sublabel && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {clip(hit.sublabel, 35)}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
        {clip(summarizeExtras(hit), 35)}
      </span>
    </Link>
  )
}

function summarizeExtras(hit: SearchHit): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(hit.extras)) {
    if (v == null || v === "" || v === false) continue
    parts.push(`${k}: ${String(v)}`)
  }
  return parts.slice(0, 3).join(" · ")
}

function clip(s: string, n: number): string {
  if (!s) return ""
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}
