import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/**
 * Timezone options for the settings pickers, **from the server**.
 *
 * Building the list from `Intl.supportedValuesOf("timeZone")` offered names a
 * canonical-only server build rejects - a browser lists `Europe/Kiev` (renamed
 * to `Europe/Kyiv` in tzdata 2022b), the save then failed with "not a valid
 * IANA timezone" for a value the app itself had shown (#31). The API answers
 * with exactly what it will accept; the browser list is only a fallback for
 * when that request hasn't resolved.
 */
export function useTimezoneOptions(): { value: string; label: string }[] {
  const q = useQuery({
    queryKey: ["timezones"],
    queryFn: () => api<{ timezones: string[] }>("/api/timezones/"),
    staleTime: 24 * 60 * 60_000, // the tz database changes a few times a year
  })
  const zones =
    q.data?.timezones ??
    (typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC"])
  return zones.map((z) => ({ value: z, label: z }))
}
