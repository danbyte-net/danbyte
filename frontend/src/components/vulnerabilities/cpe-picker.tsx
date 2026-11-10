import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Check } from "lucide-react"

import { api } from "@/lib/api"
import type { CpeSearchResult, CpeSearchRow } from "@/lib/api"
import { Field } from "@/components/forms"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { cn } from "@/lib/utils"

// The CPE half of the mapping picker (#451): words or a typed `cpe:2.3:`
// name go to /api/vulnerabilities/cpe/search/, which answers the typed name
// (checked), products already in the store, and - in server mode - NVD's
// CPE dictionary. Picking a row hands back `cpe:2.3:<part>:<vendor>:<product>`.

export const CPE_SEARCH_DEBOUNCE_MS = 300

export type CpePart = "o" | "a" | "h"

const PART_LABELS: Record<string, string> = {
  o: "OS",
  a: "Application",
  h: "Hardware",
}

/** The rows to offer, de-duplicated by name: typed first, then the store,
 * then NVD; parts outside `parts` are dropped. */
export function cpeOptions(
  data: CpeSearchResult | undefined,
  parts: readonly CpePart[]
): (CpeSearchRow & { from: "typed" | "local" | "remote" })[] {
  if (!data) return []
  const seen = new Set<string>()
  const out: (CpeSearchRow & { from: "typed" | "local" | "remote" })[] = []
  const add = (r: CpeSearchRow, from: "typed" | "local" | "remote") => {
    if (!parts.includes(r.part as CpePart) || seen.has(r.cpe)) return
    seen.add(r.cpe)
    out.push({ ...r, from })
  }
  if (data.typed) add(data.typed, "typed")
  data.local.forEach((r) => add(r, "local"))
  data.remote.forEach((r) => add(r, "remote"))
  return out
}

/** One terse line about where the answer came from. */
export function remoteNote(data: CpeSearchResult | undefined): string | null {
  if (!data || data.typed) return null
  switch (data.remote_status) {
    case "off":
      return data.update_source === "browser"
        ? "Stored products only; NVD search isn't available in browser mode."
        : "Stored products only; NVD is searched in server mode."
    case "limited":
      return `NVD is busy; try again in ${data.retry_after ?? 30} s.`
    case "error":
      return data.remote_error || "NVD did not answer."
    default:
      return null
  }
}

export function CpePicker({
  value,
  onChange,
  parts,
  initialQuery = "",
}: {
  /** The picked `cpe:2.3:part:vendor:product`, or null. */
  value: string | null
  onChange: (cpe: string | null) => void
  /** Which CPE parts the subject takes (a device type only `h`). */
  parts: readonly CpePart[]
  initialQuery?: string
}) {
  const [text, setText] = useState(initialQuery)
  const [term, setTerm] = useState(initialQuery.trim())
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), CPE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  const q = useQuery({
    queryKey: ["cpe-search", term],
    queryFn: () =>
      api<CpeSearchResult>(
        `/api/vulnerabilities/cpe/search/?q=${encodeURIComponent(term)}`
      ),
    enabled: term.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const options = useMemo(() => cpeOptions(q.data, parts), [q.data, parts])
  const note = remoteNote(q.data)

  return (
    <div className="grid gap-2">
      <Field label="Search">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ios xe, or cpe:2.3:o:cisco:ios_xe"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {term.length >= 2 && (
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {q.isLoading ? (
            <Loading />
          ) : q.isError ? (
            <div className="p-2">
              <QueryError error={q.error} />
            </div>
          ) : options.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No products.</p>
          ) : (
            <ul role="listbox" aria-label="CPE products">
              {options.map((o) => {
                const picked = o.cpe === value
                return (
                  <li key={o.cpe} role="option" aria-selected={picked}>
                    <button
                      type="button"
                      onClick={() => onChange(picked ? null : o.cpe)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted",
                        picked && "bg-muted"
                      )}
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          picked ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">
                          {o.cpe}
                        </span>
                        {o.example_title && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {o.example_title}
                          </span>
                        )}
                      </span>
                      <Badge variant="outline">
                        {PART_LABELS[o.part] ?? o.part}
                      </Badge>
                      {o.from === "local" && (
                        <Badge variant="secondary" className="num">
                          {o.cves ?? 0} stored
                        </Badge>
                      )}
                      {o.deprecated && (
                        <Badge variant="warning">Deprecated</Badge>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
