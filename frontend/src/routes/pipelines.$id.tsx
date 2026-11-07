import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeployPipeline,
  DeployPipelineCode,
  DeployPipelineRun,
  Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { pipelineToYaml } from "@/lib/pipeline-code"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { buildDeployPipelineRunColumns } from "@/components/columns/deploy-pipeline-run-columns"
import {
  isPipelineRunActive,
  PipelineStatusBadge,
} from "@/components/deploy-pipeline-status"
import {
  objectTypeLabel,
  PipelineCodeCard,
  PipelineFlow,
} from "@/components/deploy-pipeline-editor"

const OBJECT_TYPE = "integrations.deploypipeline"
type Tab = "overview" | "runs" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "runs", "journal", "history"]

export const Route = createFileRoute("/pipelines/$id")({
  component: PipelineDetail,
})

function PipelineDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["deploy-pipeline", id],
    queryFn: () => api<DeployPipeline>(`/api/deploy-pipelines/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body pipeline={q.data} />
}

function usePipelineRuns(id: string) {
  return useQuery({
    queryKey: ["deploy-pipeline-runs", "pipeline", id],
    queryFn: () =>
      api<Paginated<DeployPipelineRun>>(
        `/api/deploy-pipeline-runs/?pipeline=${id}`
      ),
    refetchInterval: (q) =>
      q.state.data?.results.some((r) => isPipelineRunActive(r.status))
        ? 3000
        : false,
  })
}

function Body({ pipeline: p }: { pipeline: DeployPipeline }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const runs = usePipelineRuns(p.id)

  return (
    <DetailShell
      backTo="/pipelines"
      backLabel="Pipelines"
      title={p.name}
      presence={{ type: "deploypipeline", id: p.id }}
      actions={
        <>
          {canDo("deploypipeline", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/pipelines/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("deploypipeline", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={p.name}
          badges={
            <>
              <Badge
                variant={p.enabled ? "success" : "secondary"}
                className="text-[10px]"
              >
                {p.enabled ? "enabled" : "disabled"}
              </Badge>
              {p.auto_on_change && (
                <Badge variant="secondary" className="text-[10px]">
                  on change
                </Badge>
              )}
            </>
          }
          subtitle={p.description || undefined}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs", count: runs.data?.count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <Overview pipeline={p} />
      </DetailTab>
      <DetailTab value="runs">
        <Runs id={p.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={p.id} />
      </DetailTab>
      <DeleteDialog
        pipeline={deleting ? p : null}
        onOpenChange={(o) => !o && setDeleting(false)}
        onDeleted={() => nav({ to: "/pipelines" })}
      />
    </DetailShell>
  )
}

function Overview({ pipeline: p }: { pipeline: DeployPipeline }) {
  const code = useQuery({
    queryKey: ["deploy-pipeline", p.id, "code", p.updated_at],
    queryFn: () =>
      api<DeployPipelineCode>(`/api/deploy-pipelines/${p.id}/export/`),
  })
  const rows: KvRow[] = [
    {
      label: "Applies to",
      value: (p.object_types.length ? p.object_types : ["device"])
        .map(objectTypeLabel)
        .join(", "),
    },
    {
      label: "Run on change",
      value: (
        <Badge
          variant={p.auto_on_change ? "success" : "secondary"}
          className="text-[10px]"
        >
          {p.auto_on_change ? "yes" : "no"}
        </Badge>
      ),
    },
    {
      label: "Default for",
      value: p.role_details.length ? (
        <span className="flex flex-wrap gap-1">
          {p.role_details.map((r) => (
            <Link key={r.id} to="/device-roles/$id" params={{ id: r.id }}>
              <ColorBadge name={r.name} color={r.color || undefined} />
            </Link>
          ))}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Last run",
      value: p.last_run ? (
        <Link
          to="/pipelines/runs/$runId"
          params={{ runId: p.last_run.id }}
          className="flex items-center gap-2"
        >
          <PipelineStatusBadge status={p.last_run.status} />
          <TimeCell iso={p.last_run.created_at} />
        </Link>
      ) : (
        <span className="text-muted-foreground">Never run</span>
      ),
    },
  ]
  const stepRows: KvRow[] = p.steps.map((s, i) => ({
    label: `Step ${i + 1}`,
    value: (
      <span className="flex flex-wrap items-center gap-2">
        <Link
          to="/automation-targets/$id"
          params={{ id: s.target }}
          className="link"
        >
          {s.target_name}
        </Link>
        <Badge variant="outline" className="text-[10px]">
          {s.target_kind_display}
        </Badge>
        {s.target_enabled === false && (
          <Badge variant="warning" className="text-[10px]">
            target disabled
          </Badge>
        )}
        {s.wait_for_result && (
          <span className="text-xs text-muted-foreground">
            waits {s.timeout_minutes} min for its result
          </span>
        )}
        {!s.stop_on_failure && (
          <span className="text-xs text-muted-foreground">
            goes on if it fails
          </span>
        )}
      </span>
    ),
  }))
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
      <div className="grid min-w-0 content-start gap-6">
        <KvCard title="Pipeline" rows={rows} />
        <KvCard title="Steps" rows={stepRows} />
      </div>
      <div className="grid min-w-0 content-start gap-4">
        <section className="grid gap-2">
          <h2 className="text-[11px] font-semibold tracking-wide uppercase">
            Flow
          </h2>
          <div className="rounded-lg border border-border bg-card p-3">
            <PipelineFlow
              trigger={p.auto_on_change ? "Deploy, or a change" : "Deploy"}
              steps={p.steps.map((s) => ({
                name: s.target_name ?? "",
                kind: s.target_kind_display,
              }))}
            />
          </div>
        </section>
        {code.data && (
          <PipelineCodeCard
            yaml={pipelineToYaml(code.data)}
            filename={`${p.name}.yaml`}
          />
        )}
      </div>
    </div>
  )
}

function Runs({ id }: { id: string }) {
  const runs = usePipelineRuns(id)
  const columns = useMemo(
    () => buildDeployPipelineRunColumns({ omit: ["pipeline"] }),
    []
  )
  if (runs.isLoading) return <Loading />
  if (runs.isError) return <QueryError error={runs.error} />
  const data = runs.data?.results ?? []
  if (data.length === 0)
    return (
      <EmptyState title="No runs yet.">Deploy a device with it.</EmptyState>
    )
  return (
    <DataTable
      data={data}
      total={runs.data?.count}
      columns={columns}
      flexColumn="run"
      tableId="deploy-pipeline-runs-of-pipeline"
    />
  )
}

function DeleteDialog({
  pipeline,
  onOpenChange,
  onDeleted,
}: {
  pipeline: DeployPipeline | null
  onOpenChange: (o: boolean) => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/deploy-pipelines/${pipeline!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${pipeline!.name}`)
      qc.invalidateQueries({ queryKey: ["deploy-pipelines"] })
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!pipeline} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pipeline?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its runs stay in the history. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
