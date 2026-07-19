import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type CheckTemplate,
  type MonitoringEngine,
  type MonitoringPolicy,
  type MonitoringProfile,
  type Paginated,
} from "@/lib/api"

export interface MonitoringConfigData {
  templates: CheckTemplate[]
  profiles: MonitoringProfile[]
  policies: MonitoringPolicy[]
  engines: MonitoringEngine[]
}

const MonitoringConfigContext = createContext<MonitoringConfigData | null>(null)

// Stable empty fallbacks — a fresh `[]` per render would rebuild every
// panel's columns memo (and re-derive the facet rails over ~500 rows) on
// each render while any of the four queries is still loading.
const EMPTY: never[] = []

// The four shared config queries are fetched ONCE here and fanned out via
// context, so switching tabs or re-rendering a panel never re-mints array
// identities.
export function MonitoringConfigProvider({
  children,
}: {
  children: ReactNode
}) {
  const templates = useQuery({
    queryKey: ["check-templates"],
    queryFn: () => api<Paginated<CheckTemplate>>("/api/monitoring/templates/"),
  })
  const profiles = useQuery({
    queryKey: ["monitoring-profiles"],
    queryFn: () =>
      api<Paginated<MonitoringProfile>>("/api/monitoring/profiles/"),
  })
  const policies = useQuery({
    queryKey: ["monitoring-policies"],
    queryFn: () =>
      api<Paginated<MonitoringPolicy>>("/api/monitoring/policies/"),
  })
  const engines = useQuery({
    queryKey: ["monitoring-engines"],
    queryFn: () => api<Paginated<MonitoringEngine>>("/api/monitoring/engines/"),
    staleTime: 60_000,
  })

  const value = useMemo<MonitoringConfigData>(
    () => ({
      templates: templates.data?.results ?? EMPTY,
      profiles: profiles.data?.results ?? EMPTY,
      policies: policies.data?.results ?? EMPTY,
      engines: engines.data?.results ?? EMPTY,
    }),
    [templates.data, profiles.data, policies.data, engines.data]
  )
  return (
    <MonitoringConfigContext.Provider value={value}>
      {children}
    </MonitoringConfigContext.Provider>
  )
}

export function useMonitoringConfig(): MonitoringConfigData {
  const ctx = useContext(MonitoringConfigContext)
  if (!ctx)
    throw new Error(
      "useMonitoringConfig must be used inside <MonitoringConfigProvider>"
    )
  return ctx
}
