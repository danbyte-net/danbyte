import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api, type CheckTemplate, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { TemplateEditor } from "./template-editor"
import { apiErrorToast } from "@/lib/api-toast"

// Reusable check library: define a check once, attach it to many IPs/prefixes,
// edit it in one place. Editing propagates to every assignment.
export function TemplatesList() {
  const q = useQuery({
    queryKey: ["check-templates"],
    queryFn: () => api<Paginated<CheckTemplate>>("/api/monitoring/templates/"),
  })
  const [editing, setEditing] = useState<CheckTemplate | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<CheckTemplate | null>(null)

  const rows = q.data?.results ?? []

  const columns: ColumnDef<CheckTemplate>[] = [
    {
      id: "name",
      accessorFn: (t) => t.name,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <>
          <button
            type="button"
            className="link font-medium"
            onClick={() => setEditing(row.original)}
          >
            {row.original.name}
          </button>
          {row.original.has_secrets && (
            <Badge variant="secondary" className="ml-2 h-4 px-1.5 text-[10px]">
              creds
            </Badge>
          )}
        </>
      ),
    },
    {
      id: "kind",
      accessorFn: (t) => t.kind,
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      meta: { label: "Type" },
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground uppercase">
          {row.original.kind}
        </span>
      ),
    },
    {
      id: "interval",
      accessorFn: (t) => t.interval_seconds,
      header: () => <div className="text-right">Interval</div>,
      meta: { label: "Interval" },
      cell: ({ row }) => (
        <div className="num text-right text-muted-foreground">
          {formatInterval(row.original.interval_seconds)}
        </div>
      ),
    },
    {
      id: "usage",
      accessorFn: (t) => t.usage_count,
      header: () => <div className="text-right">Used by</div>,
      meta: { label: "Used by" },
      cell: ({ row }) => (
        <div className="num text-right text-muted-foreground">
          {row.original.usage_count}
        </div>
      ),
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: "",
      cell: ({ row }) => (
        <RowActions
          onEdit={() => setEditing(row.original)}
          onDelete={() => setDeleting(row.original)}
        />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Reusable checks — attach one to many IPs or prefixes; editing updates
          them all.
        </p>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          Add check
        </Button>
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && rows.length === 0 ? (
        <EmptyState title="No check templates yet.">
          Create one, then attach it from any IP or prefix.
        </EmptyState>
      ) : (
        <DataTable
          tableId="check-templates"
          data={rows}
          columns={columns}
          flexColumn="name"
          exportName="check-templates"
          exportTitle="Check templates"
        />
      )}

      <TemplateEditor open={creating} onOpenChange={setCreating} />
      <TemplateEditor
        template={editing ?? undefined}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <DeleteTemplate
        template={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function DeleteTemplate({
  template,
  onOpenChange,
}: {
  template: CheckTemplate | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/templates/${template!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${template!.name}`)
      qc.invalidateQueries({ queryKey: ["check-templates"] })
      qc.invalidateQueries({ queryKey: ["ip-checks"] })
      qc.invalidateQueries({ queryKey: ["prefix-checks"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  const n = template?.usage_count ?? 0

  return (
    <AlertDialog open={!!template} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {template?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {n > 0
              ? `This check is attached to ${n} target${n === 1 ? "" : "s"}. Deleting it removes those ${n} assignment${n === 1 ? "" : "s"} too. This can't be undone.`
              : "This can't be undone."}
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

function formatInterval(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}
