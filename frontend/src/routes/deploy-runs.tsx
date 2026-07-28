import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import { api, type DeployRun, type Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { AutomationExplainer } from "@/components/automation-explainer"
import { buildDeployRunColumns } from "@/components/columns/deploy-run-columns"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const Route = createFileRoute("/deploy-runs")({
  component: DeployRunsPage,
})

const STATUSES = ["queued", "launched", "failed"] as const

function DeployRunsPage() {
  const [status, setStatus] = useState<string>("all")

  const query = useQuery({
    queryKey: ["deploy-runs", status],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== "all") p.set("status", status)
      return api<Paginated<DeployRun>>(`/api/deploy-runs/?${p.toString()}`)
    },
    refetchInterval: 10_000,
  })

  const rows = query.data?.results ?? []
  const columns = useMemo(() => buildDeployRunColumns(), [])

  return (
    <ListPageShell
      title="Deploy runs"
      count={query.data ? rows.length : undefined}
      actions={
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      query={query}
    >
      <div className="space-y-4">
        <AutomationExplainer variant="note" />
        {rows.length === 0 && status === "all" ? (
          <EmptyState title="No deploy runs yet.">
            Deploy a device from its Config tab, or enable{" "}
            <span className="font-medium">Auto-deploy on change</span> on an
            automation target.
          </EmptyState>
        ) : (
          <DataTable
            data={rows}
            columns={columns}
            flexColumn="detail"
            tableId="deploy-runs"
          />
        )}
      </div>
    </ListPageShell>
  )
}
