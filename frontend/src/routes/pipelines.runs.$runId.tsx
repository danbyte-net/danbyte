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
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
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
  runObjectsLabel,
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

  const started = run.started_at ?? run.created_at
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
          title={`${run.pipeline_name} · ${runObjectsLabel(run)}`}
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
          subtitle={
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{runTriggerLabel(run)}</span>
              <span>
                {run.object_ids.length}{" "}
                {run.object_type === "virtualmachine" ? "VM" : "device"}
                {run.object_ids.length === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1">
                Started <TimeCell iso={started} />
              </span>
              {run.duration_ms != null && (
                <span>Duration {formatDeployDuration(run.duration_ms)}</span>
              )}
              {run.rerun_of && (
                <Link
                  to="/pipelines/runs/$runId"
                  params={{ runId: run.rerun_of }}
                  className="link"
                >
                  Re-run of #{run.rerun_of_numid}
                </Link>
              )}
            </span>
          }
        />
      }
      tabs={[{ value: "steps", label: "Steps", count: run.steps.length }]}
      tab="steps"
      onTabChange={() => {}}
    >
      <DetailTab value="steps">
        <div className="grid gap-6">
          {run.detail && run.status !== "succeeded" && (
            <p
              className={cn(
                "text-[13px]",
                run.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {run.detail}
            </p>
          )}
          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[11px] font-semibold tracking-wide uppercase">
                Steps
              </h2>
              <span className="text-xs text-muted-foreground">
                Each step starts when the one before has a final status.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-y-2">
              {run.steps.map((s, i) => (
                <Fragment key={s.step}>
                  <StepNode
                    step={s}
                    selected={s.step === step.step}
                    onPick={() => setPicked(s.step)}
                  />
                  {i < run.steps.length - 1 && (
                    <span
                      aria-hidden
                      className="h-0.5 w-6 shrink-0 bg-border"
                    />
                  )}
                </Fragment>
              ))}
            </div>
          </section>
          <StepLog step={step} />
          {run.next_payload && (
            <section className="grid gap-2">
              <h2 className="text-[11px] font-semibold tracking-wide uppercase">
                What the next step receives
              </h2>
              <p className="text-xs text-muted-foreground">
                The ids, the event and every earlier step&apos;s status and
                outputs, besides the target&apos;s own extra vars.
              </p>
              <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-relaxed">
                {JSON.stringify(run.next_payload, null, 2)}
              </pre>
            </section>
          )}
        </div>
      </DetailTab>
    </DetailShell>
  )
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

function StepLog({ step: s }: { step: DeployPipelineRunStep }) {
  const lines = (s.log ?? "").replace(/\n$/, "").split("\n")
  const hasLog = !!s.log
  const waiting =
    s.status === "running" && s.wait_for_result && s.kind !== "script"
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
        <div className="grid gap-0.5">
          <h2 className="text-[13px] font-semibold">
            {s.step} · {s.target_name}
          </h2>
          <span className="text-xs text-muted-foreground">
            {s.detail ? s.detail.split("\n")[0] : stepNote(s)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>
      <div className="max-h-[32rem] overflow-auto bg-zinc-950 py-3 font-mono text-[12px] leading-relaxed text-zinc-200">
        {hasLog ? (
          <ol>
            {lines.map((l, i) => (
              <li key={i} className="flex gap-4 px-4 whitespace-pre">
                <span className="num w-8 shrink-0 text-right text-zinc-500 select-none">
                  {i + 1}
                </span>
                <span>{l}</span>
              </li>
            ))}
            {waiting && (
              <li className="flex gap-4 px-4 text-amber-300">
                <span className="w-8 shrink-0" />
                <span>waiting for result…</span>
              </li>
            )}
          </ol>
        ) : (
          <p className="px-4 text-zinc-400">
            {s.log_source === "hidden"
              ? "You may not see this script's runs."
              : waiting
                ? "Waiting for the runner to report…"
                : s.deploy_run
                  ? "No log lines."
                  : "This step has not started."}
          </p>
        )}
      </div>
    </section>
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
