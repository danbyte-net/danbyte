import type { ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"
import { useDiscoveryTab } from "./discovery-tab"

type DiscoveryView = "profiles" | "findings" | "ports"

const ROUTES: Record<
  DiscoveryView,
  "/discovery" | "/discovery/findings" | "/discovery/services"
> = {
  profiles: "/discovery",
  findings: "/discovery/findings",
  ports: "/discovery/services",
}

/** A total from a paginated list, read with one row. */
function useCount(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["discovery", "count", path],
    queryFn: () => api<{ count: number }>(`${path}?page_size=1`),
    enabled,
    select: (d) => d.count,
    retry: false,
  })
}

/**
 * Monitoring → Discovery: one row of tabs over its three lists - the
 * profiles and their runs, the review queue, and the open ports - each its
 * own route, so the sidebar entry stays lit and a link lands on the tab.
 */
export function DiscoveryFrame({
  value,
  children,
}: {
  value: DiscoveryView
  children: ReactNode
}) {
  const nav = useNavigate()
  const visible = useDiscoveryTab()
  const findings = useCount("/api/discovery/findings/", visible)
  const ports = useCount("/api/discovery/services/", visible)
  return (
    <MonitoringTabs
      label="Discovery views"
      banner={false}
      value={value}
      onValueChange={(v) => nav({ to: ROUTES[v] })}
      items={
        visible
          ? [
              { value: "profiles", label: "Profiles" },
              {
                value: "findings",
                label: "Findings",
                count: findings.data || null,
              },
              {
                value: "ports",
                label: "Open ports",
                count: ports.data || null,
              },
            ]
          : []
      }
    >
      {children}
    </MonitoringTabs>
  )
}
