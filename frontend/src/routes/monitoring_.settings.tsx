import { createFileRoute, Link } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import { usePageTitle } from "@/lib/page-title"
import { Button } from "@/components/ui/button"
import { MonitoringSettingsForm } from "@/components/monitoring/settings-form"
import { MonitoringTabs } from "@/components/monitoring/monitoring-tabs"

// Monitoring → Settings: the tenant's monitoring settings, beside the pages
// they shape (#63). Was /monitoring?view=settings, which redirects here with
// its #anchor. The sidebar entry and the form share the users.manage gate,
// so a hand-typed URL shows nothing without it.
export const Route = createFileRoute("/monitoring_/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  usePageTitle("Monitoring settings")
  const { canManage, canManageDeployment } = useMe()
  return (
    <MonitoringTabs label="Settings" padded banner={false}>
      {canManage && (
        <div className="space-y-4">
          <div className="flex min-h-8 items-center gap-3">
            <h1 className="text-base font-semibold">Settings</h1>
            {/* Drift runs and the email digest are set once for the
                install, on the deployment half of Settings → Monitoring. */}
            {canManageDeployment && (
              <Button size="sm" variant="outline" className="ml-auto" asChild>
                <Link
                  to="/settings/monitoring"
                  search={{ scope: "deployment" }}
                >
                  Deployment settings
                </Link>
              </Button>
            )}
          </div>
          <MonitoringSettingsForm />
        </div>
      )}
    </MonitoringTabs>
  )
}
