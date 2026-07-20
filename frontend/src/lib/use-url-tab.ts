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
 */
export function useUrlTab<T extends string = string>(
  defaultTab: T,
  key = "tab"
): [T, (value: string) => void] {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const raw = search[key]
  const tab = (typeof raw === "string" ? raw : defaultTab) as T

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
