import { useEffect, useState } from "react"
import { useMatches, useNavigate, useSearch } from "@tanstack/react-router"

// Per-user default-tab preference (#5). A detail page normally opens on its
// first tab ("overview"); this lets a user pin a different starting tab per page
// type (e.g. always open a prefix on its IPs tab). Stored in localStorage keyed
// by the route *pattern* (`/prefixes/$id`) so it applies to every object of that
// type, and only consulted when the URL carries no explicit `?tab=`.
const DEFAULT_TAB_PREFIX = "danbyte.defaultTab:"

function readStoredDefault(pageKey: string | null): string | null {
  if (!pageKey || typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(DEFAULT_TAB_PREFIX + pageKey)
  } catch {
    return null
  }
}

/** Set (or clear, with `null`) the pinned default tab for a page pattern. */
export function writeStoredDefault(
  pageKey: string,
  value: string | null
): void {
  if (typeof window === "undefined") return
  try {
    if (value) window.localStorage.setItem(DEFAULT_TAB_PREFIX + pageKey, value)
    else window.localStorage.removeItem(DEFAULT_TAB_PREFIX + pageKey)
  } catch {
    /* storage unavailable (private mode / quota) - pinning is best-effort */
  }
}

/** Stable key for the current detail page: its route pattern + the tab param
 * name (so `?tab=` and `?sub=` pin independently). Null when no route matched
 * (e.g. the unit-test mock), which disables the preference entirely. */
function usePageKey(tabKey: string): string | null {
  const matches = useMatches() as Array<{ routeId?: string }> | undefined
  const routeId = matches?.[matches.length - 1]?.routeId
  return routeId ? `${routeId}:${tabKey}` : null
}

/**
 * Detail-page tab state backed by the URL (`?tab=<value>`), so the active tab
 * survives reloads, is shareable, and moves with browser back/forward - instead
 * of resetting to the default the way local `useState` did.
 *
 * Drop-in for `const [tab, setTab] = useState<T>("overview")`:
 *
 *   const [tab, setTab] = useUrlTab<DeviceTab>("overview")
 *   <DetailShell tab={tab} onTabChange={setTab} …>
 *
 * The setter takes a plain string (matches `DetailShell.onTabChange` /
 * `SegmentedTabs.onValueChange`) and is narrowed back to `T` on read. The
 * default value is written as *no* param (a clean URL on the default tab);
 * `strict:false` reads the param regardless of whether the route declares it,
 * and the function updater preserves any other search params on the URL.
 *
 * Pass `valid` to allow-list the accepted values, so a hand-typed or stale
 * param outside the list reads back as `defaultTab` instead of selecting a tab
 * that doesn't exist. Omit it and any string is taken as-is.
 */
export function useUrlTab<T extends string = string>(
  defaultTab: T,
  key = "tab",
  valid?: readonly T[]
): [T, (value: string) => void] {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const raw = search[key]
  const known = typeof raw === "string" && (!valid || valid.includes(raw as T))
  // No explicit ?tab= → honour the user's pinned default for this page, if any
  // and still valid; otherwise the caller's hard-coded default.
  const pageKey = usePageKey(key)
  // Read the pinned default only AFTER hydration. Reading localStorage during
  // render makes the server (no localStorage → defaultTab) and the client (the
  // pinned tab) disagree on the first paint - an SSR hydration mismatch + flash.
  // Starting null means the first client render matches the server; the effect
  // then applies the pin.
  const [stored, setStored] = useState<string | null>(null)
  useEffect(() => {
    setStored(known ? null : readStoredDefault(pageKey))
  }, [known, pageKey])
  const preferred =
    stored && (!valid || valid.includes(stored as T))
      ? (stored as T)
      : defaultTab
  const tab = (known ? raw : preferred) as T

  const setTab = (value: string) => {
    void navigate({
      to: ".",
      replace: false,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [key]: value === defaultTab ? undefined : value,
      }),
    })
  }

  return [tab, setTab]
}

/** The `?sub=` param name, in one place so every sub-tab strip agrees. */
const SUB_TAB_KEY = "sub"

/**
 * The *second*, independent tab level: the sub-tab strip inside a top-level tab
 * (a device's Components → Power, a device type's Components → Power outlets),
 * backed by `?sub=<value>`.
 *
 * A sub-tab kept in `useState` is unshareable and forgotten - the inactive pane
 * is unmounted, so the selection dies on a reload, a deep link, or a trip
 * through any other top-level tab. `?tab=` and `?sub=` are written
 * independently (each setter merges into the existing search), so
 * `?tab=components&sub=power` links straight at a device's power ports, and
 * leaving Components and coming back restores the sub-tab you were on.
 *
 * `valid` is required here - a sub-tab strip is always a fixed, small set, and
 * this fallback is what keeps a junk `?sub=` from rendering an empty pane
 * (the router happily passes through a value no route validated). A route with
 * a `validateSearch` should still declare `sub` next to `tab`, so the param is
 * part of its typed contract and a typed `Link` can deep-link a sub-tab.
 */
export function useUrlSubTab<T extends string>(
  defaultSub: T,
  valid: readonly T[]
): [T, (value: string) => void] {
  return useUrlTab<T>(defaultSub, SUB_TAB_KEY, valid)
}

/**
 * Controls for the "pin this tab as my default" affordance (#5). Returns the
 * currently pinned tab for this page (or null) and a setter. The DetailShell tab
 * strip uses this to show a pin toggle; pinning writes the localStorage default
 * that :func:`useUrlTab` reads on a param-less visit.
 */
export function useDefaultTabPref(key = "tab"): {
  pinned: string | null
  setPinned: (value: string | null) => void
} {
  const pageKey = usePageKey(key)
  const [pinned, setPinnedState] = useState<string | null>(() =>
    readStoredDefault(pageKey)
  )
  // Re-sync when navigating between pages of different types (pageKey changes).
  useEffect(() => {
    setPinnedState(readStoredDefault(pageKey))
  }, [pageKey])
  const setPinned = (value: string | null) => {
    if (!pageKey) return
    writeStoredDefault(pageKey, value)
    setPinnedState(value)
  }
  return { pinned, setPinned }
}
