import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Play, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, Script, ScriptParam, ScriptRun } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe, objCan } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { QueryError } from "@/components/query-error"
import { SimpleTable } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"
import { CodeEditor } from "@/components/code-editor"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { RunStatusBadge } from "@/components/script-run-status"
import { ScriptRunDialog } from "@/components/script-dialogs"
import { ScriptSettingsPanel } from "@/components/script-settings-panel"
import { ScriptSharingPanel } from "@/components/script-sharing-panel"
import { ScriptSchedulePanel } from "@/components/script-schedule-panel"

const OBJECT_TYPE = "script"
const TABS = [
  "overview",
  "runs",
  "schedule",
  "sharing",
  "journal",
  "history",
] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute("/scripts/$id")({
  component: ScriptDetailPage,
})

function ScriptDetailPage() {
  const { id } = Route.useParams()
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const [running, setRunning] = useState(false)

  const query = useQuery({
    queryKey: ["script", id],
    queryFn: () => api<Script>(`/api/scripts/${id}/`),
  })
  const runs = useQuery({
    queryKey: ["script-runs", id],
    queryFn: () => api<Paginated<ScriptRun>>(`/api/scripts/runs/?script=${id}`),
    refetchInterval: (q) =>
      q.state.data?.results.some(
        (r) => r.status === "queued" || r.status === "running"
      )
        ? 3000
        : false,
  })

  const script = query.data
  const [source, setSource] = useState("")
  useEffect(() => {
    if (script) setSource(script.source)
  }, [script?.id, script?.updated_at])

  const save = useMutation({
    mutationFn: (body: Partial<Script>) =>
      api<Script>(`/api/scripts/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success("Saved")
      void qc.invalidateQueries({ queryKey: ["script", id] })
      void qc.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (query.error) return <QueryError error={query.error} />
  if (!script)
    return <p className="text-sm text-muted-foreground">Loading...</p>

  const canEdit = objCan(script, "change", canDo("script", "change"))
  const canRun = script.permissions?.run ?? canDo("script", "run")
  const dirty = source !== script.source

  return (
    <DetailShell
      backTo="/scripts"
      backLabel="Scripts"
      title={script.name}
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs", count: script.run_count },
        { value: "schedule", label: "Schedule" },
        { value: "sharing", label: "Sharing" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
      actions={
        canRun && script.enabled ? (
          <Button size="sm" onClick={() => setRunning(true)}>
            <Play className="size-3.5" /> Run
          </Button>
        ) : null
      }
    >
      <DetailTab value="overview">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {script.trusted && (
              <Badge variant="warning">
                <ShieldCheck /> Trusted - reaches the database directly
              </Badge>
            )}
            {!script.enabled && <Badge variant="outline">Disabled</Badge>}
            <Badge variant="secondary">
              {script.token_scope === "read" ? "Read only" : "Read and write"}
            </Badge>
            <Badge variant="secondary">{script.timeout_seconds}s timeout</Badge>
            {script.description && (
              <span className="text-xs text-muted-foreground">
                {script.description}
              </span>
            )}
          </div>
          <CodeEditor
            value={source}
            onChange={canEdit ? setSource : undefined}
            language="python"
            readOnly={!canEdit}
            height="30rem"
          />
          {canEdit && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate({ source })}
              >
                {save.isPending ? "Saving..." : "Save"}
              </Button>
              {dirty && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSource(script.source)}
                >
                  Discard
                </Button>
              )}
            </div>
          )}
          <ScriptSettingsPanel script={script} canEdit={canEdit} />
        </div>
      </DetailTab>

      <DetailTab value="runs">
        <SimpleTable
          columns={[
            {
              id: "when",
              header: "Started",
              cell: (r: ScriptRun) => <TimeCell iso={r.created_at} />,
            },
            {
              id: "status",
              header: "Status",
              cell: (r: ScriptRun) => <RunStatusBadge status={r.status} />,
            },
            {
              id: "by",
              header: "By",
              flex: true,
              cell: (r: ScriptRun) =>
                r.scheduled ? "Schedule" : (r.started_by_name ?? ""),
            },
            {
              id: "took",
              header: "Took",
              cell: (r: ScriptRun) =>
                r.duration_seconds == null ? "" : `${r.duration_seconds}s`,
            },
            {
              id: "outputs",
              header: "Files",
              cell: (r: ScriptRun) => r.outputs.length || "",
            },
            {
              id: "open",
              header: "",
              align: "right",
              cell: (r: ScriptRun) => (
                <Link
                  to="/scripts/runs/$runId"
                  params={{ runId: r.id }}
                  className="link text-xs"
                >
                  Open
                </Link>
              ),
            },
          ]}
          data={runs.data?.results ?? []}
          getRowKey={(r) => r.id}
          empty="This script has not run yet."
        />
      </DetailTab>

      <DetailTab value="schedule">
        <ScriptSchedulePanel script={script} canEdit={canEdit} />
      </DetailTab>

      <DetailTab value="sharing">
        <ScriptSharingPanel script={script} canEdit={canEdit} />
      </DetailTab>

      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={script.id} />
      </DetailTab>

      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={script.id} />
      </DetailTab>

      {running && (
        <ScriptRunDialog script={script} onClose={() => setRunning(false)} />
      )}
    </DetailShell>
  )
}

export type { ScriptParam }
