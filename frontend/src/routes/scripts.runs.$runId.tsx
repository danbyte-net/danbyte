import { useEffect, useRef, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { ScriptRunDetail } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { CodeEditor } from "@/components/code-editor"
import { FormCheckbox } from "@/components/forms/checkbox"
import { EmptyState } from "@/components/empty-state"
import { ScriptOutputCard } from "@/components/script-output"
import { isRunActive, RunStatusBadge } from "@/components/script-run-status"
import { useUrlTab } from "@/lib/use-url-tab"

const TABS = ["log", "outputs", "code"] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute("/scripts/runs/$runId")({
  component: ScriptRunPage,
})

function ScriptRunPage() {
  const { runId } = Route.useParams()
  const qc = useQueryClient()
  const [tab, setTab] = useUrlTab<Tab>("log", "tab", TABS)
  const [follow, setFollow] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)

  const query = useQuery({
    queryKey: ["script-run", runId],
    queryFn: () => api<ScriptRunDetail>(`/api/scripts/runs/${runId}/`),
    // Poll while the run is moving; stop the moment it lands.
    refetchInterval: (q) =>
      q.state.data && isRunActive(q.state.data.status) ? 2000 : false,
  })
  const run = query.data

  useEffect(() => {
    if (follow && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [run?.log, follow])

  const cancel = useMutation({
    mutationFn: () =>
      api<ScriptRunDetail>(`/api/scripts/runs/${runId}/cancel/`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["script-run", runId] })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (query.error) return <QueryError error={query.error} />
  if (!run) return <p className="text-sm text-muted-foreground">Loading...</p>

  const params = Object.entries(run.params).filter(([, v]) => v != null)

  return (
    <DetailShell
      backTo="/scripts/$id"
      backParams={{ id: run.script }}
      backLabel={run.script_name}
      title={
        <span className="flex items-center gap-2">
          {run.script_name} run
          <RunStatusBadge status={run.status} />
          {run.trusted && <Badge variant="warning">Trusted</Badge>}
          {run.scheduled && <Badge variant="secondary">Scheduled</Badge>}
        </span>
      }
      tabs={[
        { value: "log", label: "Log" },
        { value: "outputs", label: "Files", count: run.outputs.length },
        { value: "code", label: "Code" },
      ]}
      tab={tab}
      onTabChange={setTab}
      actions={
        isRunActive(run.status) ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            {cancel.isPending ? "Stopping..." : "Stop"}
          </Button>
        ) : (
          <Link
            to="/scripts/$id"
            params={{ id: run.script }}
            className="link text-xs"
          >
            Open the script
          </Link>
        )
      }
    >
      <DetailTab value="log">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Started {run.started_at ? <TimeCell iso={run.started_at} /> : "-"}
            </span>
            {run.duration_seconds != null && (
              <span>Took {run.duration_seconds}s</span>
            )}
            <span>
              As {run.run_as_name ?? "-"}
              {run.started_by_name && run.started_by_name !== run.run_as_name
                ? ` (started by ${run.started_by_name})`
                : ""}
            </span>
            {run.exit_code != null && <span>Exit code {run.exit_code}</span>}
            <FormCheckbox
              label="Follow"
              checked={follow}
              onChange={setFollow}
              className="ml-auto"
            />
          </div>
          {params.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {params.map(([k, v]) => (
                <Badge key={k} variant="secondary">
                  {k} = {String(v)}
                </Badge>
              ))}
            </div>
          )}
          {run.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[13px]">
              {run.error}
            </div>
          )}
          <pre
            ref={logRef}
            className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
          >
            {run.log ||
              (isRunActive(run.status)
                ? "Waiting for output..."
                : "No output.")}
          </pre>
          {run.truncated && (
            <p className="text-xs text-muted-foreground">
              The log hit its size limit and was cut short.
            </p>
          )}
        </div>
      </DetailTab>

      <DetailTab value="outputs">
        {run.outputs.length === 0 ? (
          <EmptyState title="No files">
            This run produced no files.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {run.outputs.map((o) => (
              <ScriptOutputCard
                key={o.id}
                runId={run.id}
                output={o}
                // One file is the common case, and it is what you came for.
                defaultOpen={run.outputs.length === 1}
              />
            ))}
          </div>
        )}
      </DetailTab>

      <DetailTab value="code">
        <CodeEditor
          value={run.source}
          language="python"
          readOnly
          height="30rem"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          The code as it was when this run started.
        </p>
      </DetailTab>
    </DetailShell>
  )
}
