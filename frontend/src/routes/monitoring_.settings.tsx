import { createFileRoute, Link } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import { usePageTitle } from "@/lib/page-title"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  const { canManage } = useMe()
  return (
    <MonitoringTabs label="Settings" padded banner={false}>
      {canManage && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Settings &amp; defaults</CardTitle>
              <CardDescription>
                Stale thresholds, the skip policy, and the global schedule
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MonitoringSettingsForm />
            </CardContent>
          </Card>
          <p className="text-[11px] text-muted-foreground">
            Deployment-wide scheduling for drift runs and the email digest lives
            in{" "}
            <Link
              to="/settings/monitoring"
              search={{ scope: "deployment" }}
              className="link"
            >
              Settings → Monitoring
            </Link>
            .
          </p>
        </div>
      )}
    </MonitoringTabs>
  )
}
