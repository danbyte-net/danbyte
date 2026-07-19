import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { DetailActions } from "@/components/detail-actions"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, RotateCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { JobDetail } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { StateBadge, fmtDuration } from "./jobs.index"

export const Route = createFileRoute("/jobs/$id")({ component: JobDetailPage })

const TERMINAL = new Set(["finished", "failed", "canceled", "stopped"])

function JobDetailPage() {
  const { id } = Route.useParams()
  const { can } = useMe()

  const q = useQuery({
    queryKey: ["job", id],
    queryFn: () => api<JobDetail>(`/api/jobs/${id}/`),
    enabled: can("jobs.manage"),
    // Keep polling a live job; stop once it reaches a terminal state.
    refetchInterval: (query) =>
      TERMINAL.has(query.state.data?.state ?? "") ? false : 2000,
  })

  if (!can("jobs.manage")) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        You don't have permission to view background jobs.
      </div>
    )
  }
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body job={q.data} />
}

function Body({ job }: { job: JobDetail }) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const requeue = useMutation({
    mutationFn: () => api(`/api/jobs/${job.id}/requeue/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Job requeued")
      qc.invalidateQueries({ queryKey: ["job", job.id] })
      qc.invalidateQueries({ queryKey: ["jobs"] })
    },
    onError: (e) => toast.error(`Couldn't requeue: ${e.message}`),
  })

  const cancel = useMutation({
    mutationFn: () => api(`/api/jobs/${job.id}/cancel/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Job cancelled & removed")
      qc.invalidateQueries({ queryKey: ["jobs"] })
      navigate({ to: "/jobs" })
    },
    onError: (e) => toast.error(`Couldn't cancel: ${e.message}`),
  })

  const canRequeue = job.state === "failed"
  const canCancel = ["queued", "deferred", "scheduled", "started"].includes(
    job.state
  )

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/jobs">
              <ChevronLeft className="h-3 w-3" /> Jobs
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="truncate font-mono font-semibold tracking-tight text-foreground">
            {job.func_short}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <DetailActions />
          <StateBadge state={job.state} />
          {canRequeue && (
            <Button
              variant="secondary"
              size="sm"
              disabled={requeue.isPending}
              onClick={() => requeue.mutate()}
            >
              <RotateCw className="h-3.5 w-3.5" /> Requeue
            </Button>
          )}
          {canCancel && (
            <Button
              variant="secondary"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <Trash2 className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          {job.corrupt && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">
              This job's payload can't be deserialized — the code or module that
              enqueued it no longer exists. Timestamps are still accurate; the
              function name and arguments are unavailable. You can safely cancel
              it to clear it from the queue.
            </div>
          )}

          <div className="rounded-lg border border-border bg-card">
            <dl className="divide-y divide-border text-sm">
              <Field label="Job ID">
                <span className="font-mono text-[13px]">{job.id}</span>
              </Field>
              <Field label="Function">
                <span className="font-mono text-[13px]">
                  {job.func_name || "—"}
                </span>
              </Field>
              <Field label="Queue">
                <span className="font-mono text-[13px]">{job.queue}</span>
              </Field>
              {job.worker_name && (
                <Field label="Worker">
                  <span className="font-mono text-[13px]">
                    {job.worker_name}
                  </span>
                </Field>
              )}
              <Field label="Enqueued">{fmtTs(job.enqueued_at)}</Field>
              <Field label="Started">{fmtTs(job.started_at)}</Field>
              <Field label="Ended">{fmtTs(job.ended_at)}</Field>
              <Field label="Duration">
                <span className="font-mono tabular-nums">
                  {fmtDuration(job.duration)}
                </span>
              </Field>
              <Field label="Timeout">
                <span className="font-mono tabular-nums">
                  {job.timeout ?? "—"}
                </span>
              </Field>
              {job.description && (
                <Field label="Description">
                  <span className="font-mono text-[12px] break-all">
                    {job.description}
                  </span>
                </Field>
              )}
            </dl>
          </div>

          {job.args.length > 0 && (
            <Block title="Arguments">
              <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap">
                {job.args.map((a, i) => `[${i}] ${a}`).join("\n")}
              </pre>
            </Block>
          )}

          {Object.keys(job.kwargs).length > 0 && (
            <Block title="Keyword arguments">
              <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap">
                {Object.entries(job.kwargs)
                  .map(([k, v]) => `${k} = ${v}`)
                  .join("\n")}
              </pre>
            </Block>
          )}

          {job.result != null && (
            <Block title="Result">
              <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">
                {job.result}
              </pre>
            </Block>
          )}

          {job.exc_info && (
            <Block title="Traceback" danger>
              <pre className="overflow-x-auto font-mono text-[12px] whitespace-pre-wrap text-red-700 dark:text-red-300">
                {job.exc_info}
              </pre>
            </Block>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-3 gap-4 px-5 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-words">{children}</dd>
    </div>
  )
}

function Block({
  title,
  danger,
  children,
}: {
  title: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={
        "rounded-lg border bg-card " +
        (danger ? "border-destructive/30" : "border-border")
      }
    >
      <div className="border-b border-border px-4 py-2 text-sm font-semibold">
        {title}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  )
}

function fmtTs(iso: string | null) {
  if (!iso) return <span className="text-muted-foreground">—</span>
  return (
    <span className="font-mono text-[12px]" title={iso}>
      {new Date(iso).toLocaleString()}
    </span>
  )
}
