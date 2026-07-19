import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type Silence } from "@/lib/api"
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

export function SilencesList() {
  const { canDo } = useMe()
  const canAdd = canDo("silence", "add")
  const canEdit = canDo("silence", "change")
  const canDelete = canDo("silence", "delete")
  const q = useQuery({
    queryKey: ["silences"],
    queryFn: () => api<Paginated<Silence>>("/api/monitoring/silences/"),
    refetchInterval: 60_000,
  })
  const [deleting, setDeleting] = useState<Silence | null>(null)
  const rows = q.data?.results ?? []

  const columns: ColumnDef<Silence>[] = [
    {
      id: "reason",
      accessorFn: (s) => s.reason || "(no reason)",
      header: ({ column }) => <SortHeader column={column} label="Reason" />,
      cell: ({ row }) => (
        <Link
          to="/silences/$id/edit"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.reason || "(no reason)"}
        </Link>
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
      id: "window",
      enableSorting: false,
      header: "Window",
      cell: ({ row }) => (
        <span className="num text-[11px] text-muted-foreground">
          {new Date(row.original.starts_at).toLocaleString()} →{" "}
          {new Date(row.original.ends_at).toLocaleString()}
        </span>
      ),
    },
    {
      id: "state",
      enableSorting: false,
      header: "State",
      cell: ({ row }) => {
        const s = row.original
        return s.is_active ? (
          <Badge variant="warning">Active</Badge>
        ) : new Date(s.starts_at).getTime() > Date.now() ? (
          <Badge variant="secondary">Scheduled</Badge>
        ) : (
          <Badge variant="outline">Expired</Badge>
        )
      },
    },
    {
      id: "actions",
      enableSorting: false,
      enableHiding: false,
      header: "",
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/silences/$id/edit" : undefined}
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
          A silence mutes notifications for matching alerts during its window.
          One scheduled for the future is a maintenance window — alerts still
          open, they just aren&apos;t delivered.
        </p>
        {canAdd && (
          <Button size="sm" className="ml-auto" asChild>
            <Link to="/silences/new">
              <Plus className="h-3.5 w-3.5" /> New silence
            </Link>
          </Button>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
          No silences — every matching alert notifies.
        </div>
      ) : (
        <DataTable
          tableId="silences"
          data={rows}
          columns={columns}
          flexColumn="matches"
        />
      )}

      <DeleteSilence
        silence={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function matchSummary(s: Silence): string {
  const parts: string[] = []
  if (s.match_ip_address) parts.push(s.match_ip_address)
  if (s.match_prefix_cidr) parts.push(`in ${s.match_prefix_cidr}`)
  if (s.match_kinds.length) parts.push(s.match_kinds.join("/"))
  if (s.match_statuses.length) parts.push(s.match_statuses.join("/"))
  if (s.match_tag_slugs.length)
    parts.push(`tags: ${s.match_tag_slugs.join(",")}`)
  return parts.length ? parts.join(" · ") : "everything (blanket)"
}

function DeleteSilence({
  silence,
  onOpenChange,
}: {
  silence: Silence | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/silences/${silence!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Silence deleted")
      qc.invalidateQueries({ queryKey: ["silences"] })
      qc.invalidateQueries({ queryKey: ["alerts"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!silence} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this silence?</AlertDialogTitle>
          <AlertDialogDescription>
            Matching alerts will notify again immediately.
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
