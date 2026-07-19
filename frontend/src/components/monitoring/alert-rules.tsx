import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AlertRule,
  type AlertSeverity,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
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
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

const SEV_VARIANT: Record<
  AlertSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

export function AlertRulesList() {
  const { canDo } = useMe()
  const canAdd = canDo("alertrule", "add")
  const canEdit = canDo("alertrule", "change")
  const canDelete = canDo("alertrule", "delete")
  const q = useQuery({
    queryKey: ["alert-rules"],
    queryFn: () => api<Paginated<AlertRule>>("/api/monitoring/alert-rules/"),
  })
  const [deleting, setDeleting] = useState<AlertRule | null>(null)
  const rows = q.data?.results ?? []

  const columns: ColumnDef<AlertRule>[] = [
    {
      id: "rule",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <>
          <Link
            to="/alert-rules/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          {!row.original.enabled && (
            <Badge variant="outline" className="ml-2 h-4 px-1.5 text-[10px]">
              off
            </Badge>
          )}
        </>
      ),
    },
    {
      id: "matches",
      enableSorting: false,
      header: "Matches",
      cell: ({ row }) => (
        <span className="text-[12px] text-muted-foreground">
          {matchSummary(row.original)}
        </span>
      ),
    },
    {
      id: "severity",
      accessorFn: (r) => r.severity,
      header: ({ column }) => <SortHeader column={column} label="Severity" />,
      cell: ({ row }) => (
        <Badge
          variant={SEV_VARIANT[row.original.severity]}
          className="capitalize"
        >
          {row.original.severity}
        </Badge>
      ),
    },
    {
      id: "firing",
      accessorFn: (r) => r.alert_count,
      header: () => <div className="text-right">Firing</div>,
      cell: ({ row }) => (
        <div className="num text-right text-muted-foreground">
          {row.original.alert_count}
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
          editTo={canEdit ? "/alert-rules/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => setDeleting(row.original) : undefined}
        />
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Rules decide which check failures alert, and at what severity. With no
          rules, the default is down/stale → critical, degraded → warning.
        </p>
        {canAdd && (
          <Button size="sm" className="ml-auto" asChild>
            <Link to="/alert-rules/new">
              <Plus className="h-3.5 w-3.5" /> New rule
            </Link>
          </Button>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
          No rules — the default severity policy is in effect.
        </div>
      ) : (
        <DataTable
          tableId="alert-rules"
          data={rows}
          columns={columns}
          flexColumn="matches"
        />
      )}

      <DeleteRule
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function matchSummary(r: AlertRule): string {
  const parts: string[] = []
  parts.push(r.match_kinds.length ? r.match_kinds.join("/") : "any kind")
  parts.push(
    r.match_statuses.length ? r.match_statuses.join("/") : "any bad status"
  )
  if (r.match_tag_slugs.length)
    parts.push(`tags: ${r.match_tag_slugs.join(",")}`)
  if (r.match_prefix_cidr) parts.push(`in ${r.match_prefix_cidr}`)
  return parts.join(" · ")
}

function DeleteRule({
  rule,
  onOpenChange,
}: {
  rule: AlertRule | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/alert-rules/${rule!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rule!.name}`)
      qc.invalidateQueries({ queryKey: ["alert-rules"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!rule} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {rule?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This rule will no longer set severity for matching failures.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
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
