import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Reusable checks — attach one to many IPs or prefixes; editing updates
          them all.
        </p>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New check
        </Button>
      </div>

      {q.isError && <QueryError error={q.error} />}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted/40 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Interval</th>
              <th className="px-3 py-2 text-right font-medium">Used by</th>
              <th className="w-20 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((t) => (
              <tr key={t.id} className="hover:bg-muted/40">
                <td className="px-3 py-1.5">
                  <button
                    type="button"
                    className="font-medium hover:underline"
                    onClick={() => setEditing(t)}
                  >
                    {t.name}
                  </button>
                  {t.has_secrets && (
                    <Badge
                      variant="secondary"
                      className="ml-2 h-4 px-1.5 text-[10px]"
                    >
                      creds
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground uppercase">
                    {t.kind}
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {formatInterval(t.interval_seconds)}
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {t.usage_count}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => setEditing(t)}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleting(t)}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {q.data && rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No check templates yet. Create one, then attach it from any IP
                  or prefix.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

function formatInterval(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}
