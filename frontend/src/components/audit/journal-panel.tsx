import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type JournalEntry,
  type JournalKind,
  type Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { apiErrorToast } from "@/lib/api-toast"

const KIND_VARIANT: Record<
  JournalKind,
  "secondary" | "success" | "warning" | "destructive"
> = {
  info: "secondary",
  success: "success",
  warning: "warning",
  danger: "destructive",
}
const KIND_OPTIONS = [
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "danger", label: "Danger" },
]

/**
 * Per-object journal — free-form notes humans write about an object (distinct
 * from the auto change log). Drop into a detail-page "Journal" tab. Anyone can
 * add a note; authors (and superusers) can edit/delete their own.
 */
export function JournalPanel({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const qc = useQueryClient()
  const key = ["journal", objectType, objectId]
  const invalidate = () => qc.invalidateQueries({ queryKey: key })

  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Paginated<JournalEntry>>(
        `/api/journal/?object_type=${objectType}&object_id=${objectId}`
      ),
    staleTime: 0,
  })
  const rows = q.data?.results ?? []

  const [comments, setComments] = useState("")
  const [kind, setKind] = useState<JournalKind>("info")
  const add = useMutation({
    mutationFn: () =>
      api<JournalEntry>("/api/journal/", {
        method: "POST",
        body: JSON.stringify({
          object_type: objectType,
          object_id: objectId,
          kind,
          comments,
        }),
      }),
    onSuccess: () => {
      setComments("")
      setKind("info")
      invalidate()
      toast.success("Note added")
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <div className="space-y-4">
      {/* Composer */}
      <div className="rounded-lg border border-border bg-card p-3">
        <Textarea
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Write a note about this object…"
          className="min-h-20 text-[13px]"
        />
        <div className="mt-2 flex items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as JournalKind)}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!comments.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? "Adding…" : "Add note"}
          </Button>
        </div>
      </div>

      {q.isError && <QueryError error={q.error} />}
      {q.data && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No journal notes yet.
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((e) => (
          <JournalRow key={e.id} e={e} onChanged={invalidate} />
        ))}
      </ul>
    </div>
  )
}

function JournalRow({
  e,
  onChanged,
}: {
  e: JournalEntry
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(e.comments)

  const save = useMutation({
    mutationFn: () =>
      api<JournalEntry>(`/api/journal/${e.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ comments: draft }),
      }),
    onSuccess: () => {
      setEditing(false)
      onChanged()
      toast.success("Note updated")
    },
    onError: (err) => apiErrorToast(err),
  })
  const del = useMutation({
    mutationFn: () => api(`/api/journal/${e.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      onChanged()
      toast.success("Note deleted")
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Badge variant={KIND_VARIANT[e.kind]} className="capitalize">
          {e.kind_display}
        </Badge>
        <span className="font-medium">{e.author_name || "system"}</span>
        <TimeCell iso={e.created_at} />
        {e.can_edit && !editing && (
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Edit"
              onClick={() => {
                setDraft(e.comments)
                setEditing(true)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Delete"
              disabled={del.isPending}
              onClick={() => del.mutate()}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="mt-2">
          <Textarea
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            className="min-h-20 text-[13px]"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!draft.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[13px] whitespace-pre-wrap">{e.comments}</p>
      )}
    </li>
  )
}
