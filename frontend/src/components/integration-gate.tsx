import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { activeNavUrl, sections } from "@/components/app-sidebar"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { api } from "@/lib/api"
import { useMe } from "@/lib/use-me"

/** What Settings → Integrations calls each toggle the nav gates on. */
const INTEGRATION_NAMES: Record<string, string> = {
  dhcp: "DHCP sync",
  dns: "DNS sync",
  virtualization: "Virtualization sync",
  ai: "Agent access",
  zabbix: "Zabbix",
  prtg: "PRTG",
  oxidized: "Oxidized",
}

/** Nav URL → the toggles that open it, from the same sidebar model that hides
 * the entry, so a page and its menu item can never disagree. */
const GATED: Map<string, readonly string[]> = new Map(
  sections.flatMap((s) =>
    s.clusters.flatMap((c) =>
      c.items
        .filter((i) => i.integration?.length)
        .map((i) => [i.url, i.integration!] as const)
    )
  )
)

/** The toggles a path needs (any one of them), or null when it needs none. */
export function integrationKeysFor(pathname: string): readonly string[] | null {
  const url = activeNavUrl(pathname, [...GATED.keys()])
  return url ? GATED.get(url)! : null
}

/** "Zabbix is off." / "DHCP sync and DNS sync are off." */
export function integrationOffTitle(keys: readonly string[]): string {
  const names = keys.map((k) => INTEGRATION_NAMES[k] ?? k)
  return names.length === 1
    ? `${names[0]} is off.`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are off.`
}

/**
 * A page that belongs to an integration renders only while that integration
 * is on (#429). The API 404s every endpoint behind a switched-off toggle, so
 * opening such a page by link or bookmark used to show the raw "Integration
 * not enabled." error beside an Add button that could not work. The page is
 * not mounted at all instead - no failing request, no create action - and an
 * admin gets the way to the switch. Enforcement stays on the server; if the
 * toggle list cannot be read the page renders as before.
 */
export function IntegrationGate({
  pathname,
  children,
}: {
  pathname: string
  children: ReactNode
}) {
  const keys = integrationKeysFor(pathname)
  const toggles = useQuery({
    // Shared with the sidebar, which already holds it.
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
    enabled: keys !== null,
  })
  const { canManage } = useMe()

  if (keys === null) return children
  if (toggles.isPending) return <Loading />
  if (!toggles.data || keys.some((k) => toggles.data[k])) return children

  return (
    <div className="p-4 lg:p-6">
      <EmptyState title={integrationOffTitle(keys)}>
        {canManage ? (
          <>
            Turn it on in{" "}
            <Link to="/settings/integrations" className="link">
              Settings → Integrations
            </Link>
            .
          </>
        ) : (
          "An administrator can turn it on in Settings → Integrations."
        )}
      </EmptyState>
    </div>
  )
}
