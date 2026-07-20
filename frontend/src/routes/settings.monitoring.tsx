import { createFileRoute, Link } from "@tanstack/react-router"

import { MonitoringSettingsForm } from "@/components/monitoring/settings-form"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/settings/monitoring")({
  component: MonitoringSettingsPage,
})

function MonitoringSettingsPage() {
  const { canManage, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-medium">users.manage</span>{" "}
        permission to change monitoring settings.
      </p>
    )
  return (
    <div className="space-y-6">
      <div className="mb-4">
        <h1 className="text-base font-medium">Monitoring</h1>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          Global schedule, stale thresholds, skip policy, reverse-DNS, alerting,
          discovery &amp; cleanup, and the flapping monitor. The same settings
          appear on the{" "}
          <Link
            to="/monitoring"
            search={{ view: "overview", status: "all" }}
            className="underline underline-offset-2"
          >
            Monitoring dashboard
          </Link>
          .
        </p>
      </div>
      <MonitoringSettingsForm />
    </div>
  )
}
