import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import type { ExportTemplate } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { downloadBlob } from "@/lib/table-export"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildExportTemplateColumns } from "@/components/columns/export-template-columns"
import { ExportTemplateDeleteDialog } from "@/components/export-template-delete-dialog"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useUrlSearch } from "@/lib/url-filters"

// Render + download a template's output. Fetches the file so we can surface a
// render error as a toast instead of downloading an error page.
function DownloadButton({ template }: { template: ExportTemplate }) {
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/export-templates/${template.id}/render/`, {
        credentials: "include",
      })
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          detail = (await res.json()).detail ?? detail
        } catch {
          /* keep */
        }
        throw new Error(detail)
      }
      const text = await res.text()
      const ext = (template.file_extension || "txt").replace(/^\./, "")
      downloadBlob(
        `${template.name}.${ext}`,
        template.mime_type || "text/plain",
        text
      )
    },
    onError: (err) => toast.error(`Render failed: ${err.message}`),
  })
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title="Render & download"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">Render &amp; download</span>
    </Button>
  )
}

export const Route = createFileRoute("/export-templates/")({
  component: ExportTemplatesPage,
})

function ExportTemplatesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("exporttemplate", "add")
  const canEdit = canDo("exporttemplate", "change")
  const canDelete = canDo("exporttemplate", "delete")
  const selectable = canEdit || canDelete
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<ExportTemplate | null>(null)
  const [selected, setSelected] = useState<ExportTemplate[]>([])

  const query = useQuery({
    queryKey: ["export-templates", q],
    queryFn: () =>
      apiAll<ExportTemplate>(
        `/api/export-templates/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: ExportTemplate) => setDeleting(t), [])
  const columns = useMemo(
    () =>
      buildExportTemplateColumns({
        humanIds,
        selection: selectable,
        actions: {
          editTo: "/export-templates/$id/edit",
          editParams: (t) => ({ id: t.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
          extra: (t) => <DownloadButton template={t} />,
        },
      }),
    [onDelete, humanIds, canEdit, canDelete, selectable]
  )

  return (
    <ListPageShell
      title="Export templates"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter templates…",
      }}
      actions={
        <>
          <TableActions ioType="exporttemplate" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/export-templates/new">Add template</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        total={query.data?.count}
        columns={columns}
        flexColumn="description"
        tableId="export-templates"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/export-templates/"
        noun={["template", "templates"]}
        invalidate={[["export-templates"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="exporttemplate"
      />
      <ExportTemplateDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
