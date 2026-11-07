import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Upload } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeployPipeline, DeployPipelineRun } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { parsePipelineYaml, PipelineCodeError } from "@/lib/pipeline-code"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FormTextarea } from "@/components/forms"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DevicePicker } from "@/components/device-picker"
import { buildDeployPipelineColumns } from "@/components/columns/deploy-pipeline-columns"
import { buildDeployPipelineRunColumns } from "@/components/columns/deploy-pipeline-run-columns"
import {
  isPipelineRunActive,
  PipelineStatusBadge,
} from "@/components/deploy-pipeline-status"

export const Route = createFileRoute("/pipelines/")({
  component: PipelinesPage,
})

const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"]

type View = "pipelines" | "runs"
const VIEWS: readonly View[] = ["pipelines", "runs"]

/** The pipelines and every run, one table each behind a tab. */
function PipelinesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("deploypipeline", "add")
  const [importing, setImporting] = useState(false)
  const [view, setView] = useUrlTab<View>("pipelines", "view", VIEWS)
  const [status, setStatus] = useState("all")
  const [device, setDevice] = useState<string | null>(null)

  const pipelines = useQuery({
    queryKey: ["deploy-pipelines"],
    queryFn: () => apiAll<DeployPipeline>("/api/deploy-pipelines/"),
  })
  const runs = useQuery({
    queryKey: ["deploy-pipeline-runs", status, device],
    queryFn: () => {
      const p = new URLSearchParams()
      if (status !== "all") p.set("status", status)
      if (device) p.set("device", device)
      return apiAll<DeployPipelineRun>(
        `/api/deploy-pipeline-runs/?${p.toString()}`
      )
    },
    refetchInterval: (q) =>
      q.state.data?.results.some((r) => isPipelineRunActive(r.status))
        ? 3000
        : 15_000,
  })
  const rows = pipelines.data?.results ?? []
  const runRows = runs.data?.results ?? []
  const pipelineColumns = useMemo(() => buildDeployPipelineColumns(), [])
  const runColumns = useMemo(() => buildDeployPipelineRunColumns(), [])

  return (
    <ListPageShell
      title="Pipelines"
      count={pipelines.data ? rows.length : undefined}
      actions={
        <>
          {view === "runs" && (
            <>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger
                  aria-label="Status"
                  className="h-8 w-36 shrink-0 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      <PipelineStatusBadge
                        status={s as DeployPipelineRun["status"]}
                      />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="w-64 shrink-0">
                <DevicePicker
                  label="Device"
                  labelHidden
                  value={device}
                  onChange={setDevice}
                  noneLabel="Any device"
                  placeholder="Any device"
                />
              </div>
            </>
          )}
          {canAdd && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImporting(true)}
              >
                <Upload className="size-3.5" /> Import YAML
              </Button>
              <Button size="sm" asChild>
                <Link to="/pipelines/new">
                  <Plus className="size-3.5" /> New pipeline
                </Link>
              </Button>
            </>
          )}
        </>
      }
      query={pipelines}
    >
      <div className="grid gap-4">
        <SegmentedTabs
          value={view}
          onValueChange={setView}
          items={[
            { value: "pipelines", label: "Pipelines", count: rows.length },
            { value: "runs", label: "Runs", count: runs.data?.count },
          ]}
        />
        {view === "pipelines" &&
          (rows.length === 0 ? (
            <EmptyState title="No pipelines yet.">
              Add one, or import one as YAML.
            </EmptyState>
          ) : (
            <DataTable
              data={rows}
              total={pipelines.data?.count}
              columns={pipelineColumns}
              flexColumn="name"
              tableId="deploy-pipelines"
            />
          ))}
        {view === "runs" && (
          <DataTable
            data={runRows}
            total={runs.data?.count}
            columns={runColumns}
            flexColumn="run"
            tableId="deploy-pipeline-runs"
          />
        )}
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </ListPageShell>
  )
}

function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  const nav = useNavigate()
  const m = useMutation({
    mutationFn: () => {
      const body = parsePipelineYaml(text)
      return api<DeployPipeline>("/api/deploy-pipelines/import/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["deploy-pipelines"] })
      toast.success(`Imported ${p.name}`)
      onOpenChange(false)
      setText("")
      nav({ to: "/pipelines/$id", params: { id: p.id } })
    },
    onError: (err) => {
      if (err instanceof PipelineCodeError) setError(err.message)
      else apiErrorToast(err)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Import pipeline</DialogTitle>
          <DialogDescription>
            Targets and roles match by name; a pipeline of the same name is
            updated.
          </DialogDescription>
        </DialogHeader>
        <FormTextarea
          label="YAML"
          rows={12}
          value={text}
          onChange={(v) => {
            setText(v)
            setError(null)
          }}
          error={error ?? undefined}
        />
        <input
          ref={file}
          type="file"
          accept=".yaml,.yml,.json,text/yaml,application/json"
          className="hidden"
          aria-label="YAML file"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f) setText(await f.text())
            e.target.value = ""
          }}
        />
        <DialogFooter>
          <Button
            variant="outline"
            className="mr-auto"
            onClick={() => file.current?.click()}
          >
            Choose file
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim() || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
