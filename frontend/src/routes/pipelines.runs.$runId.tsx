import { Fragment, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeployPipelineRun,
  DeployPipelineRunDetail,
  DeployPipelineRunStep,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { FileViewer } from "@/components/file-viewer"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import {
  isPipelineRunActive,
  PipelineStatusBadge,
} from "@/components/deploy-pipeline-status"
import { formatDeployDuration } from "@/components/columns/deploy-run-columns"
import {
  runLabel,
  runTriggerLabel,
} from "@/components/columns/deploy-pipeline-run-columns"

export const Route = createFileRoute("/pipelines/runs/$runId")({
  component: PipelineRunPage,
})

const KIND: Partial<Record<string, string>> = {
  script: "Script",
  webhook: "Webhook",
  awx: "AWX",
}

/** Objects named on the Run card before the rest collapse into "+N". */
const OBJECTS_SHOWN = 12

function PipelineRunPage() {
  const { runId } = Route.useParams()
  const query = useQuery({
    queryKey: ["deploy-pipeline-run", runId],
    queryFn: () =>
      api<DeployPipelineRunDetail>(`/api/deploy-pipeline-runs/${runId}/`),
    refetchInterval: (q) =>
      q.state.data && isPipelineRunActive(q.state.data.status) ? 2000 : false,
  })
  if (query.error)
    return (
      <div className="p-6">
        <QueryError error={query.error} />
      </div>
    )
  if (!query.data) return <Loading />
  return <Body run={query.data} />
}

/** The step to show first: the one running, else the one that failed, else
 * the last that started. */
function initialStep(run: DeployPipelineRunDetail): number {
  const running = run.steps.find((s) => s.status === "running")
  if (running) return running.step
  const failed = run.steps.find((s) => s.status === "failed")
  if (failed) return failed.step
  const started = run.steps.filter((s) => s.deploy_run)
  return started.length ? started[started.length - 1].step : 1
}

function Body({ run }: { run: DeployPipelineRunDetail }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const { canDo } = useMe()
  const [picked, setPicked] = useState<number | null>(null)
  const sel = picked ?? initialStep(run)
  const step = run.steps.find((s) => s.step === sel) ?? run.steps[0]
  const active = isPipelineRunActive(run.status)
  const canChange = canDo("deploypipelinerun", "change")

  const cancel = useMutation({
    mutationFn: () =>
      api<DeployPipelineRunDetail>(
        `/api/deploy-pipeline-runs/${run.id}/cancel/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      qc.setQueryData(["deploy-pipeline-run", run.id], r)
      qc.invalidateQueries({ queryKey: ["deploy-pipeline-runs"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const rerun = useMutation({
    mutationFn: () =>
      api<DeployPipelineRun>(`/api/deploy-pipeline-runs/${run.id}/rerun/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["deploy-pipeline-runs"] })
      toast.success(`Run ${runLabel(r)} started`)
      nav({ to: "/pipelines/runs/$runId", params: { runId: r.id } })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <DetailShell
      backTo="/pipelines"
      backLabel="Pipelines"
      crumbs={
        run.pipeline ? (
          <Link
            to="/pipelines/$id"
            params={{ id: run.pipeline }}
            className="hover:text-foreground"
          >
            {run.pipeline_name}
          </Link>
        ) : (
          <span>{run.pipeline_name}</span>
        )
      }
      title={`Run ${runLabel(run)}`}
      actions={
        canChange && (
          <>
            {active && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <Square className="h-3.5 w-3.5" />
                {cancel.isPending ? "Cancelling…" : "Cancel run"}
              </Button>
            )}
            {!active && run.pipeline && (
              <Button
                size="sm"
                onClick={() => rerun.mutate()}
                disabled={rerun.isPending}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {rerun.isPending ? "Starting…" : "Re-run"}
              </Button>
            )}
          </>
        )
      }
      hero={
        <DetailHero
          title={`${run.pipeline_name} ${runLabel(run)}`}
          badges={
            <>
              <PipelineStatusBadge status={run.status} />
              {run.dry_run && (
                <Badge variant="outline" className="text-[10px]">
                  Dry run
                </Badge>
              )}
            </>
          }
        />
      }
      tabs={[{ value: "overview", label: "Overview" }]}
      tab="overview"
      onTabChange={() => {}}
    >
      <DetailTab value="overview">
        <div className="grid gap-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <KvCard title="Run" rows={runRows(run)} />
            <KvCard title="Timing" rows={timingRows(run)} />
          </div>
          <Section title="Steps" count={run.steps.length}>
            <div className="flex flex-wrap items-center gap-y-2">
              {run.steps.map((s, i) => (
                <Fragment key={s.step}>
                  <StepNode
                    step={s}
                    selected={s.step === step.step}
                    onPick={() => setPicked(s.step)}
                  />
                  {i < run.steps.length - 1 && (
                    <span aria-hidden className="h-px w-6 shrink-0 bg-border" />
                  )}
                </Fragment>
              ))}
            </div>
          </Section>
          <StepLog step={step} />
          {run.next_payload && (
            <Section title="What the next step receives">
              <FileViewer
                text={JSON.stringify(run.next_payload, null, 2)}
                filename={`run-${runLabel(run).replace("#", "")}-payload.json`}
                language="json"
                height="fit"
                storageKey="pipeline-next-payload"
                label="What the next step receives"
              />
            </Section>
          )}
        </div>
      </DetailTab>
    </DetailShell>
  )
}

function runRows(run: DeployPipelineRunDetail): KvRow[] {
  const vm = run.object_type === "virtualmachine"
  const shown = run.objects.slice(0, OBJECTS_SHOWN)
  const more = run.object_ids.length - shown.length
  const rows: KvRow[] = [
    {
      label: "Pipeline",
      value: run.pipeline ? (
        <Link
          to="/pipelines/$id"
          params={{ id: run.pipeline }}
          className="link"
        >
          {run.pipeline_name}
        </Link>
      ) : (
        run.pipeline_name
      ),
    },
    {
      label: vm ? "Virtual machines" : "Devices",
      value: shown.length ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {shown.map((o) =>
            vm ? (
              <Link
                key={o.id}
                to="/virtual-machines/$id"
                params={{ id: o.id }}
                className="link"
              >
                {o.name}
              </Link>
            ) : (
              <Link
                key={o.id}
                to="/devices/$id"
                params={{ id: o.id }}
                className="link"
              >
                {o.name}
              </Link>
            )
          )}
          {more > 0 && (
            <Badge variant="secondary" className="num text-[10px]">
              +{more}
            </Badge>
          )}
        </span>
      ) : (
        <span className="num">{run.object_ids.length}</span>
      ),
    },
    { label: "Trigger", value: runTriggerLabel(run) },
  ]
  if (run.rerun_of)
    rows.push({
      label: "Re-run of",
      value: (
        <Link
          to="/pipelines/runs/$runId"
          params={{ runId: run.rerun_of }}
          className="link num"
        >
          #{run.rerun_of_numid}
        </Link>
      ),
    })
  if (run.detail && run.status !== "succeeded")
    rows.push({
      label: run.status === "failed" ? "Error" : "Detail",
      value: (
        <span
          className={cn(
            run.status === "failed" ? "text-destructive" : "text-foreground"
          )}
        >
          {run.detail}
        </span>
      ),
    })
  return rows
}

function timingRows(run: DeployPipelineRunDetail): KvRow[] {
  return [
    { label: "Created", value: <TimeCell iso={run.created_at} /> },
    {
      label: "Started",
      value: run.started_at ? <TimeCell iso={run.started_at} /> : dash,
    },
    {
      label: "Finished",
      value: run.finished_at ? <TimeCell iso={run.finished_at} /> : dash,
    },
    {
      label: "Duration",
      value:
        run.duration_ms != null ? (
          <span className="num">{formatDeployDuration(run.duration_ms)}</span>
        ) : (
          dash
        ),
    },
  ]
}

function StepNode({
  step: s,
  selected,
  onPick,
}: {
  step: DeployPipelineRunStep
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "grid min-w-52 flex-1 gap-2 rounded-lg border bg-card px-3 py-2.5 text-left",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40"
      )}
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="num text-muted-foreground">{s.step}</span>
        <span className="truncate">{s.target_name}</span>
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          {KIND[s.kind ?? ""] ?? s.kind ?? "-"}
        </Badge>
        <PipelineStatusBadge status={s.status} />
        <span className="num ml-auto">
          {s.duration_ms != null ? formatDeployDuration(s.duration_ms) : ""}
        </span>
      </span>
    </button>
  )
}

/** The picked step's log, in the shared viewer, under a heading that names
 * the step and carries its files and link. */
function StepLog({ step: s }: { step: DeployPipelineRunStep }) {
  const waiting =
    s.status === "running" && s.wait_for_result && s.kind !== "script"
  return (
    <Section
      title={`Step ${s.step} · ${s.target_name ?? ""}`}
      badge={
        waiting ? (
          <Badge variant="warning" className="text-[10px]">
            Waiting for result
          </Badge>
        ) : undefined
      }
      description={s.detail ? s.detail.split("\n")[0] : stepNote(s)}
      actions={
        <>
          {(s.outputs ?? []).map((o) => (
            <Button key={o.url} variant="outline" size="sm" asChild>
              <a href={o.url} download={o.name}>
                <Download className="size-3.5" />
                {o.name}
              </a>
            </Button>
          ))}
          {s.script_run ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/scripts/runs/$runId" params={{ runId: s.script_run }}>
                Open script run
              </Link>
            </Button>
          ) : (
            s.target && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/automation-targets/$id" params={{ id: s.target }}>
                  Open target
                </Link>
              </Button>
            )
          )}
        </>
      }
    >
      <FileViewer
        key={s.step}
        text={(s.log ?? "").replace(/\n$/, "")}
        filename={`step-${s.step}.log`}
        language="text"
        height="fit"
        storageKey="pipeline-step-log"
        follow={s.status === "running"}
        defaultWrap
        label={`Step ${s.step} log`}
        emptyText={
          s.log_source === "hidden"
            ? "You may not see this script's runs."
            : waiting
              ? "Waiting for the runner to report…"
              : s.deploy_run
                ? "No log lines."
                : "This step has not started."
        }
      />
    </Section>
  )
}

function stepNote(s: DeployPipelineRunStep): string {
  if (!s.deploy_run) return "Not started"
  if (s.kind === "script") return "Script step"
  if (s.wait_for_result)
    return s.status === "running"
      ? "Waiting for the reported result"
      : "Reported back"
  return "Done once launched"
}
