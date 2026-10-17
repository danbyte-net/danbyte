import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"

/**
 * List filters in the URL.
 *
 * A list page's facet selections, its search box and its advanced filter live
 * in the query string, so a reload, Back from a detail page, a bookmark or a
 * pasted link all land on the same filtered list:
 *
 *   /devices?status=active,planned&role=leaf&tag=core&q=sw-01
 *
 * The scheme, shared by every list:
 *
 * - one param per facet, named after the facet (a tags facet is `tag`);
 * - several values are comma-separated; a value that itself holds a comma or
 *   a backslash escapes it with a backslash (`a\,b`), so any value
 *   round-trips. Values are stable ids and slugs, never display labels;
 * - a numeric range is `min..max`, either side optional (`util=50..`);
 * - the advanced filter expression is `expr`, the search box is `q`;
 * - nothing selected = no param at all;
 * - every write REPLACES the history entry: filtering is not a Back step,
 *   and Back from a detail page returns to the list as it was left.
 *
 * Reading never throws: a junk param reads as nothing selected.
 */

// ─── Codec ────────────────────────────────────────────────────────────────

/** Values → one param string, or undefined (drop the param) when empty. */
export function encodeList(values: Iterable<string>): string | undefined {
  const out = [...values]
    .filter((v) => v !== "")
    .map((v) => v.replace(/\\/g, "\\\\").replace(/,/g, "\\,"))
  return out.length ? out.join(",") : undefined
}

/** A param as the router hands it over → its values. The router JSON-parses
 * the query string, so `?status=1` arrives as a number and `?tag=true` as a
 * boolean; an array (a hand-written JSON param) is accepted too. Anything
 * else reads as empty. */
export function decodeList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw === "number" || typeof raw === "boolean") return [String(raw)]
  if (Array.isArray(raw))
    return raw
      .filter((v) => ["string", "number", "boolean"].includes(typeof v))
      .map(String)
      .filter((v) => v !== "")
  if (typeof raw !== "string") return []
  const out: string[] = []
  let cur = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === "\\" && i + 1 < raw.length) {
      cur += raw[++i]
    } else if (c === ",") {
      out.push(cur)
      cur = ""
    } else {
      cur += c
    }
  }
  out.push(cur)
  return [...new Set(out.filter((v) => v !== ""))]
}

export interface RangeValue {
  min: string
  max: string
}

const NUM = /^-?\d+(\.\d+)?$/

/** `{min, max}` → `min..max`; undefined when both sides are open. */
export function encodeRange(r: RangeValue): string | undefined {
  const min = r.min.trim()
  const max = r.max.trim()
  if (!min && !max) return undefined
  return `${min}..${max}`
}

/** `min..max` → `{min, max}`; a side that is not a number reads as open. */
export function decodeRange(raw: unknown): RangeValue {
  const empty = { min: "", max: "" }
  if (typeof raw === "number") return { min: String(raw), max: String(raw) }
  if (typeof raw !== "string") return empty
  const parts = raw.split("..")
  if (parts.length !== 2) return empty
  const side = (s: string) => (NUM.test(s.trim()) ? s.trim() : "")
  return { min: side(parts[0]), max: side(parts[1]) }
}

/** A text param (`q`, `expr`): strings as-is, router-coerced scalars back to
 * their text. */
export function decodeText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  return ""
}

/** The values of `selected` the list actually has - a stale or hand-typed
 * value is ignored rather than filtering everything out. While nothing is
 * known yet (rows still loading) the selection is kept as it is. */
export function pruneUnknown(
  selected: Set<string>,
  known: Iterable<string> | null | undefined
): Set<string> {
  if (selected.size === 0 || !known) return selected
  const have = new Set(known)
  if (have.size === 0) return selected
  let all = true
  for (const v of selected) if (!have.has(v)) all = false
  if (all) return selected
  return new Set([...selected].filter((v) => have.has(v)))
}

/** {@link pruneUnknown} against a facet's options, memoised so the result
 * keeps its identity (a list's filtered rows depend on it). */
export function useKnown(
  selected: Set<string>,
  options: readonly { value: string }[]
): Set<string> {
  return useMemo(
    () =>
      pruneUnknown(
        selected,
        options.map((o) => o.value)
      ),
    [selected, options]
  )
}

/** `set` with `value` flipped - for a functional setter, so two toggles in
 * one tick (a facet's "clear") both land. */
export function toggled(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

// ─── Writing ──────────────────────────────────────────────────────────────

type Search = Record<string, unknown>
type Updater = (prev: Search) => Search

// Writes queued in the same tick go out as ONE navigation. Each updater is a
// function of the URL it lands on, so two filters changed by one click (a
// "clear all", a saved view) both stick instead of the second building on a
// URL the first has not reached yet.
let queue: Updater[] = []
let flushTo: ReturnType<typeof useNavigate> | null = null

function enqueue(navigate: ReturnType<typeof useNavigate>, fn: Updater) {
  queue.push(fn)
  flushTo = navigate
  if (queue.length > 1) return
  queueMicrotask(() => {
    const fns = queue
    const nav = flushTo
    queue = []
    flushTo = null
    if (!nav || fns.length === 0) return
    void nav({
      to: ".",
      replace: true,
      search: (prev: Search) => fns.reduce((acc, f) => f(acc), { ...prev }),
    })
  })
}

/** Patch the query string: each key set, `undefined` removes it. Always a
 * history REPLACE, batched per tick. Referentially stable. */
export function useSearchWriter(): (fn: Updater) => void {
  const navigate = useNavigate()
  const ref = useRef(navigate)
  ref.current = navigate
  return useCallback((fn: Updater) => enqueue(ref.current, fn), [])
}

/** The current query string (any route, declared or not). */
export function useListSearch(): Search {
  return useSearch({ strict: false })
}

// ─── Hooks ────────────────────────────────────────────────────────────────

/**
 * One multi-value facet in the URL - the drop-in for a hand-rolled
 * `useState<Set<string>>(new Set())`. The setter takes a set or an updater.
 */
export function useUrlSet(
  key: string
): [
  Set<string>,
  (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void,
] {
  const search = useListSearch()
  const raw = search[key]
  // Keyed on the param's text, so the set keeps its identity while other
  // params change (typing in the search box must not refilter).
  const sig = encodeList(decodeList(raw)) ?? ""
  const value = useMemo(() => new Set(decodeList(raw)), [sig])
  const write = useSearchWriter()
  const set = useCallback(
    (next: Set<string> | ((prev: Set<string>) => Set<string>)) =>
      write((prev) => {
        const resolved =
          typeof next === "function"
            ? next(new Set(decodeList(prev[key])))
            : next
        return { ...prev, [key]: encodeList(resolved) }
      }),
    [key, write]
  )
  return [value, set]
}

/** How long the search box waits after the last keystroke before it writes
 * the URL. */
export const SEARCH_DEBOUNCE_MS = 300

/**
 * The list search box (`?q=`). The returned value follows every keystroke;
 * the URL catches up once typing pauses, so a reload or Back restores it
 * without a navigation per character. A URL change from elsewhere (Back, a
 * link, a saved view) flows back into the box.
 */
export function useUrlSearch(key = "q"): [string, (value: string) => void] {
  const search = useListSearch()
  const fromUrl = decodeText(search[key])
  const [local, setLocal] = useState(fromUrl)
  const written = useRef(fromUrl)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const write = useSearchWriter()

  useEffect(() => {
    if (fromUrl !== written.current) {
      written.current = fromUrl
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setLocal(fromUrl)
    }
  }, [fromUrl])

  // A pending write must not land on whatever page comes next.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const set = useCallback(
    (value: string) => {
      setLocal(value)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        written.current = value
        write((prev) => ({ ...prev, [key]: value === "" ? undefined : value }))
      }, SEARCH_DEBOUNCE_MS)
    },
    [key, write]
  )
  return [local, set]
}
