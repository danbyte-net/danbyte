import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type JournalEntry,
  type JournalKind,
  type Paginated,
  type PlanningAssignableUser,
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
 * Per-object journal - free-form notes humans write about an object (distinct
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
      {/* Composer - the textarea has its own border, so a card around it was a
          box inside a box. */}
      <div>
        <MentionTextarea
          value={comments}
          onChange={setComments}
          placeholder={
            objectType === "planning.task"
              ? "Write a comment… @name someone to notify them"
              : "Write a note about this object…"
          }
          mentions={objectType === "planning.task"}
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
        <p className="mt-2 text-[13px] whitespace-pre-wrap">
          {renderWithMentions(e.comments)}
        </p>
      )}
    </li>
  )
}

// Mirrors the server's parser (planning/notifications.py MENTION_RE) so what
// lights up here is what actually notifies.
const MENTION_RE = /@([A-Za-z0-9_.@+-]+)/g

/** The note text with @names tinted - display only, no lookup. */
function renderWithMentions(text: string) {
  const parts = text.split(MENTION_RE)
  if (parts.length === 1) return text
  // split() with one capture group alternates [plain, name, plain, name, …].
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="font-medium text-primary">
        @{part}
      </span>
    ) : (
      part
    )
  )
}

/**
 * A journal textarea that offers username completion while an "@word" token is
 * being typed at the caret. Task journals only - that's where a mention sends
 * an email; elsewhere it stays a plain textarea.
 */
function MentionTextarea({
  value,
  onChange,
  placeholder,
  mentions,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  mentions: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [token, setToken] = useState<{ start: number; text: string } | null>(
    null
  )
  const usersQ = useQuery({
    queryKey: ["planning-assignable-users"],
    queryFn: () =>
      api<{ results: PlanningAssignableUser[] }>(
        "/api/planning/assignable-users/"
      ),
    staleTime: 60_000,
    enabled: mentions,
  })
  const matches = token
    ? (usersQ.data?.results ?? [])
        .filter((u) =>
          u.username.toLowerCase().startsWith(token.text.toLowerCase())
        )
        .slice(0, 6)
    : []

  const refreshToken = (next: string, caret: number) => {
    // The live token is the "@word" the caret is sitting in, if any.
    const upto = next.slice(0, caret)
    const m = /(^|\s)@([A-Za-z0-9_.+-]*)$/.exec(upto)
    setToken(m ? { start: caret - m[2].length - 1, text: m[2] } : null)
  }

  const pick = (username: string) => {
    if (!token) return
    const caret = ref.current?.selectionStart ?? value.length
    const next = `${value.slice(0, token.start)}@${username} ${value.slice(caret)}`
    onChange(next)
    setToken(null)
    requestAnimationFrame(() => {
      const pos = token.start + username.length + 2
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          if (mentions)
            refreshToken(e.target.value, e.target.selectionStart ?? 0)
        }}
        onKeyDown={(e) => {
          if (
            token &&
            matches.length &&
            (e.key === "Enter" || e.key === "Tab")
          ) {
            e.preventDefault()
            pick(matches[0].username)
          } else if (e.key === "Escape") {
            setToken(null)
          }
        }}
        onBlur={() => setTimeout(() => setToken(null), 150)}
        placeholder={placeholder}
        className="min-h-20 text-[13px]"
      />
      {token && matches.length > 0 && (
        <div className="absolute bottom-full left-2 z-10 mb-1 w-64 rounded-md border border-border bg-popover p-1 shadow-md">
          {matches.map((u, i) => (
            <button
              key={u.id}
              type="button"
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted ${
                i === 0 ? "bg-muted/60" : ""
              }`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(u.username)
              }}
            >
              <span className="font-medium">@{u.username}</span>
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {u.display_name !== u.username ? u.display_name : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
