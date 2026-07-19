import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Rocket } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { AutomationTarget, DeployRun, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { FormSelect } from "@/components/forms"
import { TimeCell } from "@/components/cells/time-ago"
import { DeployRunStatus } from "@/components/deploy-run-status"
import { DeployRetryButton } from "@/components/deploy-retry-button"
import { apiErrorToast } from "@/lib/api-toast"

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

// Manual deploy: pick an enabled automation target and POST /devices/<id>/deploy/.
// Danbyte hands off to the runner (AWX job / signed webhook); it never SSHes the
// device itself. The runner holds device credentials.
export function DeviceDeployPanel({ deviceId }: { deviceId: string }) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const qc = useQueryClient()

  const targets = useQuery({
    queryKey: ["automation-targets", "enabled"],
    queryFn: () => api<Paginated<AutomationTarget>>("/api/automation-targets/"),
    staleTime: 60_000,
  })
  const options = (targets.data?.results ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({ value: t.id, label: `${t.name} · ${t.kind_display}` }))

  const runs = useQuery({
    queryKey: ["deploy-runs", "device", deviceId],
    queryFn: () =>
      api<Paginated<DeployRun>>(`/api/deploy-runs/?device=${deviceId}`),
    refetchInterval: 10_000,
  })
  const recent = (runs.data?.results ?? []).slice(0, 5)

  const deploy = useMutation({
    mutationFn: () =>
      api<DeployRun>(`/api/devices/${deviceId}/deploy/`, {
        method: "POST",
        body: JSON.stringify({ target_id: targetId }),
      }),
    onSuccess: (run) => {
      if (run.status === "failed")
        toast.error(`Deploy failed: ${run.detail || "see run"}`)
      else toast.success(`Deploy ${run.status}`)
      qc.invalidateQueries({ queryKey: ["deploy-runs", "device", deviceId] })
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Section
      title="Deploy"
      description="hand off to an automation target (AWX job / webhook)"
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No enabled automation targets — add one under{" "}
            <Link
              to="/automation-targets/new"
              className="font-medium underline"
            >
              Integrations → Automation targets
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="w-72">
                <FormSelect
                  label="Target"
                  value={targetId}
                  onChange={setTargetId}
                  options={options}
                  placeholder="Pick a target"
                />
              </div>
              <Button
                onClick={() => deploy.mutate()}
                disabled={!targetId || deploy.isPending}
              >
                {deploy.isPending ? (
                  <Spinner className="size-4" />
                ) : (
                  <Rocket className="size-4" />
                )}
                Deploy
              </Button>
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
              Danbyte launches the runner, which holds the device credentials —
              it never connects to the device directly.
            </p>
          </>
        )}
      </div>
    </Section>
  )
}
