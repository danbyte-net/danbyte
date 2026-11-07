import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeployPipeline, DeployPipelineRun } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { parsePipelineYaml, PipelineCodeError } from "@/lib/pipeline-code"
import { Badge } from "@/components/ui/badge"
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
import { TimeCell } from "@/components/cells/time-ago"
import { DevicePicker } from "@/components/device-picker"
import { buildDeployPipelineRunColumns } from "@/components/columns/deploy-pipeline-run-columns"
import {
  isPipelineRunActive,
  PipelineStatusBadge,
} from "@/components/deploy-pipeline-status"
import { objectTypeLabel } from "@/components/deploy-pipeline-editor"

export const Route = createFileRoute("/pipelines/")({
  component: PipelinesPage,
})

const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"]

function PipelinesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("deploypipeline", "add")
  const [importing, setImporting] = useState(false)

  const pipelines = useQuery({
    queryKey: ["deploy-pipelines"],
    queryFn: () => apiAll<DeployPipeline>("/api/deploy-pipelines/"),
  })
  const rows = pipelines.data?.results ?? []

  return (
    <ListPageShell
      title="Pipelines"
      count={pipelines.data ? rows.length : undefined}
      actions={
        canAdd && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImporting(true)}
            >
              <Upload className="size-3.5" /> Import YAML
            </Button>
            <Button size="sm" asChild>
              <Link to="/pipelines/new">New pipeline</Link>
            </Button>
          </>
        )
      }
      query={pipelines}
    >
      <div className="space-y-6">
        {rows.length === 0 ? (
          <EmptyState title="No pipelines yet.">
            A pipeline runs several automation targets in order for the same
            devices.
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((p) => (
              <PipelineCard key={p.id} pipeline={p} />
            ))}
          </div>
        )}
        <PipelineRunsSection />
      </div>
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </ListPageShell>
  )
}

function PipelineCard({ pipeline: p }: { pipeline: DeployPipeline }) {
  const facts = [
    `${p.steps_count} step${p.steps_count === 1 ? "" : "s"}`,
    (p.object_types.length ? p.object_types : ["device"])
      .map(objectTypeLabel)
      .join(", "),
    p.roles.length
      ? `${p.roles.length} role${p.roles.length === 1 ? "" : "s"}`
      : null,
    p.auto_on_change ? "on change" : "manual only",
  ].filter(Boolean)
  return (
    <Link
      to="/pipelines/$id"
      params={{ id: p.id }}
      className="grid gap-1.5 rounded-lg border border-border bg-card p-4 hover:bg-muted/40"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {p.name}
        {!p.enabled && (
          <Badge variant="secondary" className="text-[10px]">
            Disabled
          </Badge>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {p.last_run ? (
          <>
            <PipelineStatusBadge status={p.last_run.status} />
            <TimeCell iso={p.last_run.created_at} />
          </>
        ) : (
          "Never run"
        )}
      </span>
    </Link>
  )
}

function PipelineRunsSection() {
  const [status, setStatus] = useState("all")
  const [device, setDevice] = useState<string | null>(null)
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
  const columns = useMemo(() => buildDeployPipelineRunColumns(), [])
  const data = runs.data?.results ?? []
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="mr-auto text-sm font-semibold">Runs</h2>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Status" className="h-8 w-36 text-xs">
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
        <div className="w-64">
          <DevicePicker
            label="Device"
            value={device}
            onChange={setDevice}
            noneLabel="Any device"
          />
        </div>
      </div>
      <DataTable
        data={data}
        total={runs.data?.count}
        columns={columns}
        flexColumn="run"
        tableId="deploy-pipeline-runs"
      />
    </section>
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
            Targets and roles are matched by name. A pipeline of the same name
            is updated.
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
