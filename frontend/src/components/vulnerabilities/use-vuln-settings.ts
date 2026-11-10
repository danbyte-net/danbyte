import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { VulnSettings } from "@/lib/api"

export const VULN_SETTINGS_KEY = ["vulnerability-settings"] as const

/** The deployment-wide vulnerability settings (#451). Every signed-in user
 * reads `enabled`; a deployment admin gets the rest (`can_manage`). Every
 * vulnerability surface hides itself while `enabled` is false. */
export function useVulnSettings(opts: { poll?: boolean } = {}) {
  const q = useQuery({
    queryKey: VULN_SETTINGS_KEY,
    queryFn: () => api<VulnSettings>("/api/vulnerabilities/settings/"),
    staleTime: 5 * 60_000,
    refetchInterval: opts.poll
      ? (query) =>
          query.state.data?.last_run?.status === "running" ? 2000 : false
      : false,
  })
  return { ...q, enabled: !!q.data?.enabled }
}
