import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryKey } from "@tanstack/react-query"
import { RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { TextVersion, TextVersionDetail, TextVersionList } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { DataTable } from "@/components/data-table"
import { FileViewer } from "@/components/file-viewer"
import type { FileLanguage } from "@/components/file-viewer"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { buildTextVersionColumns } from "@/components/columns/text-version-columns"

/** Every saved version of a template or script body, from the change log
 * (#465): pick one to see it against the current text, or two to compare
 * them, and restore one as a new version. `endpoint` is the object's API
 * path without the trailing slash (`/api/export-templates/<id>`). */
export function TextVersionsPanel({
  endpoint,
  filename,
  language = "auto",
  canRestore,
  invalidate = [],
}: {
  endpoint: string
  filename: string
  language?: FileLanguage
  canRestore: boolean
  /** Queries to refresh after a restore (the object's own). */
  invalidate?: QueryKey[]
}) {
  const qc = useQueryClient()
  const { formatDateTime } = useDateFormat()
  const [selected, setSelected] = useState<TextVersion[]>([])
  const [confirm, setConfirm] = useState(false)

  const list = useQuery({
    queryKey: ["text-versions", endpoint],
    queryFn: () => api<TextVersionList>(`${endpoint}/versions/?page_size=500`),
  })
  const rows = useMemo(() => list.data?.results ?? [], [list.data])
  const currentSha = list.data?.current.sha256 ?? null

  // Two picked: the older against the newer. One: it against the current
  // text, so the diff is what a restore would change.
  const [older, newer] = useMemo((): [
    TextVersion | null,
    TextVersion | null,
  ] => {
    if (selected.length === 2) {
      const [a, b] = selected
      return (a.at ?? "") <= (b.at ?? "") ? [a, b] : [b, a]
    }
    return [null, selected[0] ?? null]
  }, [selected])

  const detail = useQuery({
    queryKey: ["text-versions", endpoint, newer?.id, older?.id ?? "current"],
    queryFn: () =>
      api<TextVersionDetail>(
        `${endpoint}/versions/${newer!.id}/?against=${older?.id ?? "current"}`
      ),
    enabled: !!newer,
  })

  const restore = useMutation({
    mutationFn: (v: TextVersion) =>
      api(`${endpoint}/versions/${v.id}/restore/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => {
      toast.success("Version restored")
      setConfirm(false)
      setSelected([])
      void qc.invalidateQueries({ queryKey: ["text-versions", endpoint] })
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo(
    () => buildTextVersionColumns({ selection: true, currentSha }),
    [currentSha]
  )

  if (list.isLoading) return <Loading />
  if (list.isError) return <QueryError error={list.error} />
  if (rows.length === 0)
    return <EmptyState title="No versions in the change log." />

  const single = selected.length === 1 ? selected[0] : null
  const restorable =
    canRestore && !!single && single.text_kept && single.sha256 !== currentSha
  const when = single?.at ? formatDateTime(single.at) : ""

  return (
    <div className="space-y-4">
      {(!list.data?.history_complete || !list.data.current_logged) && (
        <div className="space-y-1 text-[13px] text-muted-foreground">
          {!list.data?.history_complete && (
            <p>Older versions are past the change-log retention.</p>
          )}
          {!list.data?.current_logged && (
            <p>The current text was saved outside the change log.</p>
          )}
        </div>
      )}
      <DataTable
        data={rows}
        columns={columns}
        tableId="text-versions"
        embedded
        selectedRows={selected}
        onSelectedRowsChange={(r) => setSelected(r.slice(-2))}
      />
      {newer && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
              {older ? "Compare" : "Version"}
            </h2>
            {restorable && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm(true)}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restore this version
              </Button>
            )}
          </div>
          {detail.isLoading ? (
            <Loading />
          ) : detail.isError ? (
            <QueryError error={detail.error} />
          ) : detail.data?.text == null ? (
            <EmptyState title="Text not kept">
              The change log holds no text for this version.
            </EmptyState>
          ) : (
            <FileViewer
              key={`${newer.id}:${older?.id ?? "current"}`}
              text={detail.data.text}
              filename={filename}
              language={language}
              diff={detail.data.diff ?? null}
              diffLabel={older ? "Diff vs older" : "Diff vs current"}
              fileLabel="Text"
              defaultView={detail.data.diff ? "diff" : "file"}
              storageKey="text-versions"
              label="Version"
            />
          )}
        </section>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Restore this version?"
        description={`Saves the text from ${when} as a new version.`}
        confirmLabel="Restore"
        pendingLabel="Restoring…"
        destructive={false}
        pending={restore.isPending}
        onConfirm={() => single && restore.mutate(single)}
      />
    </div>
  )
}
