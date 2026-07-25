import { useNavigate, useSearch } from "@tanstack/react-router"

/**
 * Detail-page tab state backed by the URL (`?tab=<value>`), so the active tab
 * survives reloads, is shareable, and moves with browser back/forward — instead
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
  const tab = (known ? raw : defaultTab) as T

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
 * A sub-tab kept in `useState` is unshareable and forgotten — the inactive pane
 * is unmounted, so the selection dies on a reload, a deep link, or a trip
 * through any other top-level tab. `?tab=` and `?sub=` are written
 * independently (each setter merges into the existing search), so
 * `?tab=components&sub=power` links straight at a device's power ports, and
 * leaving Components and coming back restores the sub-tab you were on.
 *
 * `valid` is required here — a sub-tab strip is always a fixed, small set, and
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
