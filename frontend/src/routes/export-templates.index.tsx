import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Download } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type ExportTemplate, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { downloadBlob } from "@/lib/table-export"
import { numidColumn } from "@/components/cells/numid"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { ExportTemplateDeleteDialog } from "@/components/export-template-delete-dialog"

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
    onError: (err) => toast.error(`Render failed: ${(err as Error).message}`),
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
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ExportTemplate | null>(null)

  const query = useQuery({
    queryKey: ["export-templates", q],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        `/api/export-templates/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: ExportTemplate) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<ExportTemplate>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<ExportTemplate>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/export-templates/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "object_type",
        accessorKey: "object_type_label",
        header: "Object type",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.object_type_label}</span>
        ),
      },
      {
        id: "format",
        header: "Format",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            .{row.original.file_extension} · {row.original.mime_type}
          </span>
        ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/export-templates/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
            extra={<DownloadButton template={row.original} />}
          />
        ),
      },
    ],
    [onDelete, humanIds]
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
          <Button size="sm" asChild>
            <Link to="/export-templates/new">Add template</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="export-templates"
      />
      <ExportTemplateDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
