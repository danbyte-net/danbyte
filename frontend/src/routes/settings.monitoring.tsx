import { createFileRoute, Link } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import { useUrlEnum } from "@/lib/use-url-state"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { MonitoringSettingsForm } from "@/components/monitoring/settings-form"
import { MonitoringDeploymentCards } from "@/components/settings/monitoring-deployment"
import { SettingsHeader } from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/monitoring")({
  component: MonitoringSettingsPage,
})

const SCOPES = ["deployment", "tenant"] as const
type Scope = (typeof SCOPES)[number]

/** Monitoring, at both scopes (#51).
 *
 * "Monitoring" and "Monitoring defaults" were two pages whose names differed
 * by one word, and picking between them was a coin flip. The deployment half
 * is the schedules set once for the install; the tenant half is how this
 * tenant checks its own estate. */
function MonitoringSettingsPage() {
  const { canManage, canManageDeployment, isLoading } = useMe()
  const allowed = SCOPES.filter((s) =>
    s === "deployment" ? canManageDeployment : canManage
  )
  const [scope, setScope] = useUrlEnum<Scope>(
    "scope",
    allowed[0] ?? "tenant",
    SCOPES
  )

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to change monitoring settings.
      </p>
    )

  const active = allowed.includes(scope) ? scope : allowed[0]

  return (
    <div className="space-y-4">
      <SettingsHeader title="Monitoring">
        {active === "deployment" ? (
          "Schedules set once for the whole install: config-drift runs and the email digest."
        ) : (
          <>
            Schedule, stale thresholds, skip policy, reverse DNS, alerting,
            discovery and cleanup. The same settings appear under{" "}
            <Link
              to="/monitoring"
              search={{ view: "settings", status: "all" }}
              className="link"
            >
              Monitoring → Settings
            </Link>
            .
          </>
        )}
      </SettingsHeader>

      {allowed.length > 1 && (
        <SegmentedTabs
          items={[
            { value: "deployment", label: "Deployment" },
            { value: "tenant", label: "This tenant" },
          ]}
          value={active}
          onValueChange={setScope}
          className="mb-4"
        />
      )}

      {active === "deployment" ? (
        <MonitoringDeploymentCards />
      ) : (
        <MonitoringSettingsForm />
      )}
    </div>
  )
}
