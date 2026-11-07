import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Rocket } from "lucide-react"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { DeployRun } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"
import { DeployRunStatus } from "@/components/deploy-run-status"
import { DeployRetryButton } from "@/components/deploy-retry-button"
import { DeployDialog } from "@/components/deploy-dialog"
import type { DeployResult } from "@/components/deploy-dialog"

const RUN_COLUMNS: SimpleColumn<DeployRun>[] = [
  {
    id: "status",
    header: "Status",
    cell: (r) => <DeployRunStatus status={r.status} />,
  },
  {
    id: "event",
    header: "Event",
    cell: (r) => (
      <Badge variant="outline" className="text-[10px]">
        {r.event}
      </Badge>
    ),
  },
  {
    id: "target",
    header: "Target",
    flex: true,
    cell: (r) => (
      <span className="text-muted-foreground">
        {r.target_name}
        {r.detail ? ` · ${r.detail}` : ""}
      </span>
    ),
  },
  {
    id: "when",
    header: "When",
    align: "right",
    cell: (r) => <TimeCell iso={r.created_at} align="right" />,
  },
  {
    id: "retry",
    header: "",
    align: "right",
    cell: (r) => <DeployRetryButton run={r} size="icon" />,
  },
]

// Manual deploy: the Deploy dialog runs a pipeline (the device role's default
// preselected) or a single automation target, POSTing /devices/<id>/deploy/.
// Danbyte hands off to the runner (AWX job / signed webhook / script); it never
// SSHes the device itself. The runner holds device credentials.
export function DeviceDeployPanel({
  deviceId,
  deviceName,
  roleId,
}: {
  deviceId: string
  deviceName?: string
  roleId?: string | null
}) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const runs = useQuery({
    queryKey: ["deploy-runs", "device", deviceId],
    queryFn: () => apiAll<DeployRun>(`/api/deploy-runs/?device=${deviceId}`),
    refetchInterval: 10_000,
  })
  const recent = (runs.data?.results ?? []).slice(0, 5)

  return (
    <Section
      title="Deploy"
      description="hand off to a pipeline or an automation target"
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setOpen(true)}>
            <Rocket className="size-4" />
            Deploy
          </Button>
          <Link to="/pipelines" className="link text-xs">
            Pipelines
          </Link>
        </div>

        {recent.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Recent deploys
            </div>
            <SimpleTable
              columns={RUN_COLUMNS}
              data={recent}
              getRowKey={(r) => r.id}
            />
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Danbyte launches the runner, which holds the device credentials - it
          never connects to the device directly.
        </p>
      </div>
      <DeployDialog
        open={open}
        onOpenChange={setOpen}
        title={`Deploy ${deviceName ?? "this device"}`}
        objectType="device"
        roleIds={[roleId]}
        submit={(c) =>
          api<DeployResult>(`/api/devices/${deviceId}/deploy/`, {
            method: "POST",
            body: JSON.stringify(
              c.kind === "pipeline"
                ? { pipeline_id: c.id, dry_run: c.dryRun }
                : { target_id: c.id, dry_run: c.dryRun }
            ),
          })
        }
        onDone={() =>
          qc.invalidateQueries({
            queryKey: ["deploy-runs", "device", deviceId],
          })
        }
      />
    </Section>
  )
}
